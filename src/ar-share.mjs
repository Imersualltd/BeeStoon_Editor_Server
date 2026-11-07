/*
 * AR share links
 * --------------------------------------------------
 * The editor's AR button makes a GLB snapshot of the
 * scene (or of the selected objects) and uploads it here.
 * The server stores it and returns a short-lived public
 * link. Anyone with the link can open it on a phone,
 * logged in or not, and see the model at real size in
 * their room.
 *
 * POST /ar/snapshots?name=<file name>
 *   Body:  GLB bytes (application/octet-stream)
 *   Auth:  Authorization: Bearer <session ticket>
 *          (any approved session member, viewers too)
 *   Reply: { id, url, expiresAt }
 *
 * GET /ar/<id>             viewer page (model-viewer)
 * GET /ar/<id>/model.glb   the model
 *
 * The viewer page uses Google's <model-viewer>:
 *   - Android: Scene Viewer / WebXR
 *   - iPhone:  AR Quick Look, with the USDZ made on the
 *              phone from the GLB, so the editor only
 *              uploads one file
 * ar-scale="fixed" keeps the model at real size
 * (1 PlayCanvas unit = 1 metre).
 *
 * Links expire after AR_LINK_HOURS (default 24). Each
 * press of the AR button makes a new link. Expired
 * snapshots are deleted by a sweep every 30 minutes and
 * when someone opens them.
 *
 * Storage: see ar-storage.mjs (local folder or
 * S3 / DigitalOcean Spaces).
 *
 * AR_SHARING=on|off. The links are public and anonymous,
 * so with EDITOR_ACCESS=beestoon the default is off: no
 * /ar route exists (404) and session:state says
 * features.arShare=false. Without EDITOR_ACCESS the
 * default stays on (development).
 *
 * What a link exposes, on purpose: the one GLB the member
 * chose (selected models or the visible scene, textures
 * inside) and its file name. Nothing else: no session key,
 * scene id, member names or session file links. The
 * session and the member who made it are kept in
 * meta.json on the server only. Ids are 176 random bits,
 * never listed; pages are noindex / no-referrer.
 *
 * With EDITOR_ACCESS=beestoon a link lasts 2 h unless
 * AR_LINK_HOURS says otherwise, a session makes at most
 * AR_LINKS_PER_HOUR links (default 30), and an admin
 * closing the session deletes its links at once.
 */

import express from 'express';
import { setCorsOrigin } from './cors.mjs';
import { accessChecked } from './editor-access.mjs';

import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { getArStorage } from './ar-storage.mjs';
import { requireMember } from './sessions.mjs';


// Keep in sync with MAX_AR_SNAPSHOT_SIZE in the editor's ar-share.mjs
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const LINK_HOURS = Number(process.env.AR_LINK_HOURS) || (accessChecked() ? 2 : 24);

const LINKS_PER_HOUR = Number(process.env.AR_LINKS_PER_HOUR) || 30;

// sessionKey -> when its links were made (last hour)
const recentLinks = new Map();

// Set once the routes exist (revokeSessionLinks uses it)
let liveStorage = null;

const SWEEP_MS = 30 * 60 * 1000;

// Pinned so the viewer page never changes by itself
const MODEL_VIEWER_URL =
    'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';

const GLB_MAGIC = 0x46546C67;          // "glTF"

// 22 random bytes -> 30 url-safe characters, not guessable
const ID_PATTERN = /^[A-Za-z0-9_-]{30}$/;


export function arSharingEnabled(env = process.env) {

    const value = String(env.AR_SHARING || '').toLowerCase();

    if (value === 'on' || value === 'off') {
        return value === 'on';
    }

    return !accessChecked(env);
}


export function registerArShareRoutes(app) {

    if (!arSharingEnabled()) {
        console.log('AR share links: off (AR_SHARING)');
        app.use('/ar', (req, res) => {
            setCorsOrigin(req, res);
            res.status(404).send('AR share links are switched off');
        });
        return;
    }

    // Fails at start-up when the storage settings are wrong
    const storage = getArStorage();

    liveStorage = storage;


    // The editor runs on another origin, and phones fetch
    // the model from the viewer page: CORS + preflight
    app.use('/ar', (req, res, next) => {

        setCorsOrigin(req, res);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, ngrok-skip-browser-warning'
        );

        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }

        next();
    });


    app.post(
        '/ar/snapshots',
        requireMember,
        express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
        (req, res) => handleUpload(req, res, storage).catch((error) => fail(res, error))
    );

    app.get(
        '/ar/:id',
        (req, res) => handleViewer(req, res, storage).catch((error) => fail(res, error))
    );

    app.get(
        '/ar/:id/model.glb',
        (req, res) => handleModel(req, res, storage).catch((error) => fail(res, error))
    );


    app.use('/ar', (error, req, res, next) => {

        if (error?.type === 'entity.too.large') {
            res.status(413).send('Snapshot is too big for AR (max 50 MB)');
            return;
        }

        next(error);
    });


    const sweep = setInterval(() => sweepExpired(storage), SWEEP_MS);
    sweep.unref();

    console.log(`AR share links ready at POST /ar/snapshots (links last ${LINK_HOURS} h)`);
}


// ==================================================
// HANDLERS
// ==================================================

async function handleUpload(req, res, storage) {

    const body = req.body;

    if (!Buffer.isBuffer(body) || body.length < 20) {
        res.status(400).send('Empty upload');
        return;
    }

    if (body.readUInt32LE(0) !== GLB_MAGIC || body.readUInt32LE(4) !== 2) {
        res.status(415).send('Not a GLB (glTF 2.0 binary) file');
        return;
    }


    const sessionKey = req.member?.sessionKey || null;
    const now = Date.now();

    if (sessionKey) {

        const times = (recentLinks.get(sessionKey) || []).filter((t) => t > now - 3600 * 1000);

        if (times.length >= LINKS_PER_HOUR) {
            res.status(429).send('Too many AR links for this session in the last hour - try again later');
            return;
        }

        times.push(now);
        recentLinks.set(sessionKey, times);
    }


    const id = randomBytes(22).toString('base64url');

    const meta = {
        id,
        name: safeName(req.query.name),
        size: body.length,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LINK_HOURS * 3600 * 1000).toISOString(),
        // Server only (never on the page): whose links to
        // delete when the session is closed
        sessionKey,
        createdBy: req.member?.userId || null
    };

    await storage.put(id, body, meta);


    console.log(`[ar] snapshot ${id.slice(0, 6)}... session ${shortKey(sessionKey)} by ${shortKey(meta.createdBy)} (${(body.length / 1048576).toFixed(1)} MB, ${LINK_HOURS} h)`);

    res.json({
        id,
        url: `${baseUrl(req)}/ar/${id}`,
        expiresAt: meta.expiresAt
    });
}


// Capability links: not indexed, not passed on as a referrer
function privateHeaders(res) {

    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}


async function handleViewer(req, res, storage) {

    const meta = await liveMeta(req.params.id, storage);

    privateHeaders(res);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    if (!meta) {
        res.status(410).send(expiredPage());
        return;
    }

    res.send(viewerPage(meta));
}


async function handleModel(req, res, storage) {

    const meta = await liveMeta(req.params.id, storage);

    privateHeaders(res);

    if (!meta) {
        res.status(410).send('This AR link has expired');
        return;
    }

    const stream = await storage.getModelStream(meta.id);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Length', String(meta.size));

    // Not cached past the link's end
    const left = Math.max(0, Math.floor((Date.parse(meta.expiresAt) - Date.now()) / 1000));

    res.setHeader('Cache-Control', `private, max-age=${Math.min(3600, left)}`);

    await pipeline(stream, res);
}


// ==================================================
// HELPERS
// ==================================================

/*
 * The snapshot's meta, or null when the id is unknown or
 * the link has expired (an expired one is deleted).
 */
async function liveMeta(id, storage) {

    if (!ID_PATTERN.test(String(id))) {
        return null;
    }

    const meta = await storage.getMeta(id);

    if (!meta) {
        return null;
    }

    if (Date.parse(meta.expiresAt) <= Date.now()) {
        await storage.remove(id).catch(() => {});
        return null;
    }

    return meta;
}


/*
 * A session closed by its admin: its AR links stop at
 * once instead of living until they expire.
 */
export async function revokeSessionLinks(sessionKey) {

    recentLinks.delete(sessionKey);

    if (!liveStorage || !sessionKey) {
        return 0;
    }

    let removed = 0;

    try {
        for (const id of await liveStorage.listIds()) {

            const meta = await liveStorage.getMeta(id);

            if (meta?.sessionKey === sessionKey) {
                await liveStorage.remove(id);
                removed++;
            }
        }
    } catch (error) {
        console.warn('[ar] could not delete the closed session\'s links:', error.message);
    }

    if (removed) {
        console.log(`[ar] ${removed} link(s) of session ${shortKey(sessionKey)} deleted (session closed)`);
    }

    return removed;
}


function shortKey(value) {

    return value ? `${String(value).slice(0, 6)}...` : '-';
}


async function sweepExpired(storage) {

    try {

        for (const id of await storage.listIds()) {

            const meta = await storage.getMeta(id);

            // No meta = half-written or foreign file: remove
            if (!meta || Date.parse(meta.expiresAt) <= Date.now()) {
                await storage.remove(id);
            }
        }

    } catch (error) {
        console.warn('[ar] sweep failed:', error.message);
    }
}


export function baseUrl(req) {

    if (process.env.PUBLIC_BASE_URL) {
        return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    }

    // Render and most hosts sit behind an HTTPS proxy
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();

    return `${proto}://${req.get('host')}`;
}


function safeName(name) {

    const clean = String(name || 'Beestoon scene')
        .replace(/\.glb$/i, '')
        .replace(/[^\p{L}\p{N} ._()-]/gu, '')
        .trim()
        .slice(0, 80);

    return clean || 'Beestoon scene';
}


function escapeHtml(text) {

    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


function fail(res, error) {

    console.error('[ar]', error);

    if (!res.headersSent) {
        res.status(500).send('AR link failed, please try again');
    } else {
        res.destroy();
    }
}


// ==================================================
// PAGES
// ==================================================

const PAGE_STYLE = `
    :root { color-scheme: light dark; --bg: #f4f5f7; --fg: #1d1f23; --muted: #6b7078; --green: #2fa36b; }
    @media (prefers-color-scheme: dark) { :root { --bg: #16181c; --fg: #f1f2f4; --muted: #9aa0a8; } }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    main { display: flex; flex-direction: column; height: 100%; }
    header { padding: 14px 16px 6px; }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    p { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
`;


function viewerPage(meta) {

    const name = escapeHtml(meta.name);
    const src = `/ar/${meta.id}/model.glb`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name} in AR</title>
<script type="module" src="${MODEL_VIEWER_URL}"></script>
<style>
    ${PAGE_STYLE}
    model-viewer { flex: 1; width: 100%; min-height: 0; --poster-color: transparent; }
    #ar-button { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%);
        border: 0; border-radius: 999px; padding: 14px 26px; font-size: 16px; font-weight: 600;
        background: var(--green); color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    #no-ar { position: absolute; left: 16px; right: 16px; bottom: 20px; text-align: center;
        font-size: 14px; color: var(--muted); display: none; }
    #progress { position: absolute; left: 0; top: 0; height: 3px; background: var(--green); width: 0; }
</style>
</head>
<body>
<main>
    <header>
        <h1>${name}</h1>
        <p>Real-world size. Tap the button, then point your phone at the floor.</p>
    </header>
    <model-viewer
        src="${src}"
        alt="${name}"
        ar
        ar-modes="webxr scene-viewer quick-look"
        ar-scale="fixed"
        ar-placement="floor"
        camera-controls
        touch-action="pan-y"
        shadow-intensity="1"
        exposure="1">
        <div id="progress" slot="progress-bar"></div>
        <button id="ar-button" slot="ar-button">View in your space</button>
        <div id="no-ar">AR is not available on this device. Open this link on a phone (iPhone or Android).</div>
    </model-viewer>
</main>
<script type="module">
    const viewer = document.querySelector('model-viewer');
    const bar = document.getElementById('progress');

    viewer.addEventListener('progress', (e) => {
        const p = e.detail.totalProgress;
        bar.style.width = (p * 100) + '%';
        bar.style.opacity = p >= 1 ? '0' : '1';
    });

    // On desktop model-viewer hides the AR button;
    // explain why instead of showing nothing.
    viewer.addEventListener('load', () => {
        if (!viewer.canActivateAR) {
            document.getElementById('no-ar').style.display = 'block';
        }
    });
</script>
</body>
</html>`;
}


function expiredPage() {

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>AR link expired</title>
<style>
    ${PAGE_STYLE}
    main { justify-content: center; align-items: center; text-align: center; padding: 16px; }
</style>
</head>
<body>
<main>
    <h1>This AR link has expired</h1>
    <p>Ask for a new one: press the AR button in the Beestoon editor again.</p>
</main>
</body>
</html>`;
}
