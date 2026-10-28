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
 */

import express from 'express';

import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { getArStorage } from './ar-storage.mjs';
import { requireMember } from './sessions.mjs';


// Keep in sync with MAX_AR_SNAPSHOT_SIZE in the editor's ar-share.mjs
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const LINK_HOURS = Number(process.env.AR_LINK_HOURS) || 24;

const SWEEP_MS = 30 * 60 * 1000;

// Pinned so the viewer page never changes by itself
const MODEL_VIEWER_URL =
    'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';

const GLB_MAGIC = 0x46546C67;          // "glTF"

// 22 random bytes -> 30 url-safe characters, not guessable
const ID_PATTERN = /^[A-Za-z0-9_-]{30}$/;


export function registerArShareRoutes(app) {

    // Fails at start-up when the storage settings are wrong
    const storage = getArStorage();


    // The editor runs on another origin, and phones fetch
    // the model from the viewer page: CORS + preflight
    app.use('/ar', (req, res, next) => {

        res.setHeader('Access-Control-Allow-Origin', '*');
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


    const id = randomBytes(22).toString('base64url');
    const now = Date.now();

    const meta = {
        id,
        name: safeName(req.query.name),
        size: body.length,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LINK_HOURS * 3600 * 1000).toISOString()
    };

    await storage.put(id, body, meta);


    console.log(`[ar] snapshot ${id.slice(0, 6)}... ${meta.name} (${(body.length / 1048576).toFixed(1)} MB)`);

    res.json({
        id,
        url: `${baseUrl(req)}/ar/${id}`,
        expiresAt: meta.expiresAt
    });
}


async function handleViewer(req, res, storage) {

    const meta = await liveMeta(req.params.id, storage);

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

    if (!meta) {
        res.status(410).send('This AR link has expired');
        return;
    }

    const stream = await storage.getModelStream(meta.id);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Length', String(meta.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');

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


function baseUrl(req) {

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
