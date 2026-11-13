/*
 * GLB -> FBX export endpoint
 * --------------------------------------------------
 * POST /export/fbx?name=<base file name>
 * Body:  GLB bytes (application/octet-stream), made by
 *        the editor's own GLB exporter
 * Reply: application/zip   -> <name>.fbx + texture files
 *                            (when the model has textures)
 *        application/octet-stream -> <name>.fbx
 *                            (no textures)
 *        or a short plain-text error.
 *
 * Browsers cannot write FBX, so the editor sends its GLB
 * here. The conversion uses the assimp command line tool
 * (Debian package "assimp-utils", see Dockerfile).
 *
 * Why a ZIP: assimp's FBX writer does not embed
 * textures in a way Blender / Maya can read, but FBX
 * files that reference image files next to them open
 * fine. So textures are written as separate files and
 * shipped together with the FBX.
 *
 * The upload is untrusted:
 *   - size-limited, GLB header checked
 *   - textures are only taken from inside the GLB;
 *     external file / URL references are dropped, so
 *     assimp can never be pointed at server files
 *   - fixed file names in a private temp folder that is
 *     always deleted
 *   - assimp is killed if it runs too long
 *   - one conversion at a time (small free instance)
 *
 * Units: assimp 5.2 writes UnitScaleFactor 1 (centimetres)
 * while glTF data is in metres, so Blender / Maya opened
 * every export 100 times too small (checked in Blender
 * 4.x). The FBX is marked as metres (fbxInMetres).
 *
 * Errors say what happened (too slow for the server,
 * out of memory, assimp's own message, not installed)
 * instead of only "FBX export failed"; the full assimp
 * output goes to the server log. GET / reports whether
 * assimp is available (fbxExport).
 */

import express from 'express';
import { setCorsOrigin } from './cors.mjs';
import { zipSync } from 'fflate';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireEditor } from './sessions.mjs';


// Keep in sync with MAX_FBX_EXPORT_SIZE in model-converter.mjs
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// assimp needs real time on a big mesh; kept under Node's own default
// request-receive ceiling (300 s) so a slow transfer fails with a clear
// message here, not a bare connection drop further down.
const EXPORT_TIMEOUT_MS = 240 * 1000;

const ASSIMP_BIN = process.env.ASSIMP_BIN || 'assimp';

const GLB_MAGIC = 0x46546C67;          // "glTF"
const CHUNK_JSON = 0x4E4F534A;         // "JSON"
const CHUNK_BIN = 0x004E4942;          // "BIN\0"

const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp'
};


let busy = false;


export function registerExportFbxRoute(app) {

    // The editor runs on another origin: CORS + preflight
    app.use('/export/fbx', (req, res, next) => {

        setCorsOrigin(req, res);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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


    // Only admins and editors of a live session
    // (Authorization: Bearer <session ticket>)
    app.post(
        '/export/fbx',
        requireEditor,
        express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
        handleExport
    );


    app.use('/export/fbx', (error, req, res, next) => {

        if (error?.type === 'entity.too.large') {
            res.status(413).send('Model is too big for FBX export (max 500 MB)');
            return;
        }

        next(error);
    });


    checkAssimp();
    console.log('GLB -> FBX export ready at POST /export/fbx');
}


async function handleExport(req, res) {

    const baseName = safeBaseName(req.query.name);
    const body = req.body;


    if (!Buffer.isBuffer(body) || body.length < 20) {
        res.status(400).send('Empty upload');
        return;
    }


    let gltf;

    try {
        gltf = splitGlb(body);
    } catch (error) {
        res.status(415).send(`Not a valid GLB: ${error.message}`);
        return;
    }


    if (busy) {
        res.status(503).send('Export is busy, try again in a moment');
        return;
    }

    busy = true;


    const workDir = path.join(tmpdir(), `beestoon-editor-fbx-${randomUUID()}`);
    const started = Date.now();


    try {

        await mkdir(workDir, { recursive: true });


        // glTF with external .bin and image files, so the
        // FBX references real image files.
        await writeFile(path.join(workDir, 'model.bin'), gltf.bin);

        for (const image of gltf.images) {
            await writeFile(path.join(workDir, image.fileName), image.data);
        }

        await writeFile(
            path.join(workDir, 'model.gltf'),
            JSON.stringify(gltf.json)
        );


        console.log(
            `[export-fbx] ${baseName} (${formatMb(body.length)}, ` +
            `${gltf.images.length} texture(s))...`
        );


        await runAssimp(
            ['export', 'model.gltf', 'model.fbx', '-ffbx'],
            workDir
        );


        const fbx = fbxInMetres(await readFile(path.join(workDir, 'model.fbx')));


        if (!gltf.images.length) {

            res.setHeader('Content-Type', 'application/octet-stream');
            res.send(fbx);

        } else {

            // Inside the zip the FBX keeps pointing at the
            // texture files next to it.
            const files = { [`${baseName}.fbx`]: new Uint8Array(fbx) };

            for (const image of gltf.images) {
                files[image.fileName] = new Uint8Array(image.data);
            }

            res.setHeader('Content-Type', 'application/zip');
            res.send(Buffer.from(zipSync(files, { level: 6 })));
        }


        console.log(
            `[export-fbx] done ${baseName} in ` +
            `${((Date.now() - started) / 1000).toFixed(1)}s`
        );

    } catch (error) {

        console.error(`[export-fbx] failed for ${baseName} after ${((Date.now() - started) / 1000).toFixed(1)}s ` +
            `(${formatMb(body.length)}, ${gltf.images.length} texture(s)):`, error.message.replaceAll(workDir, '<work>'));
        const { status, text } = exportError(error);
        res.status(status).send(text);

    } finally {

        busy = false;

        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}


/*
 * GLB -> { json, bin, images[] } as a glTF that points at
 * "model.bin" and "texture_<n>.<ext>" next to it.
 * Only data INSIDE the GLB is kept.
 */
export function splitGlb(glb) {

    if (glb.readUInt32LE(0) !== GLB_MAGIC) {
        throw new Error('bad header');
    }

    if (glb.readUInt32LE(4) !== 2) {
        throw new Error('only glTF 2.0 is supported');
    }


    let offset = 12;
    let json = null;
    let bin = Buffer.alloc(0);

    while (offset + 8 <= glb.length) {

        const length = glb.readUInt32LE(offset);
        const type = glb.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + length;

        if (end > glb.length) {
            throw new Error('truncated chunk');
        }

        if (type === CHUNK_JSON && !json) {
            json = JSON.parse(glb.subarray(start, end).toString('utf8'));
        } else if (type === CHUNK_BIN) {
            bin = glb.subarray(start, end);
        }

        offset = end;
    }


    if (!json) {
        throw new Error('missing JSON chunk');
    }


    // Never follow external references from an upload
    json.buffers = (json.buffers || []).slice(0, 1).map(() => ({
        byteLength: bin.length,
        uri: 'model.bin'
    }));


    const images = [];

    json.images = (json.images || []).map((image, index) => {

        const view = json.bufferViews?.[image.bufferView];

        if (!view || view.buffer !== 0) {
            // External / data-URI image: dropped
            return { name: image.name || `image_${index}` };
        }

        const startByte = view.byteOffset || 0;
        const data = bin.subarray(startByte, startByte + view.byteLength);
        const extension = IMAGE_EXTENSIONS[image.mimeType] || sniffImage(data);

        if (!extension) {
            return { name: image.name || `image_${index}` };
        }

        const fileName = `texture_${index}.${extension}`;

        images.push({ fileName, data });

        return { name: image.name || fileName, uri: fileName };
    });


    return { json, bin, images };
}


function sniffImage(data) {

    if (data[0] === 0x89 && data[1] === 0x50) return 'png';
    if (data[0] === 0xFF && data[1] === 0xD8) return 'jpg';

    return null;
}


/*
 * What the person is told. Statuses Render's proxy passes on
 * (never 520-527, see matchmake-errors.mjs).
 */
export function exportError(error) {

    if (error.code === 'ENOENT') {
        return { status: 501, text: 'FBX export is not installed on this server (the assimp converter is missing). Export GLB instead.' };
    }

    if (error.timedOut) {
        return { status: 503, text: `FBX conversion took longer than ${EXPORT_TIMEOUT_MS / 1000} s on the server and was stopped. ` +
            'Export fewer objects at once, or export GLB.' };
    }

    if (error.signal) {
        return { status: 503, text: 'The server ran out of resources converting this scene to FBX. ' +
            'Export fewer objects at once, or export GLB.' };
    }

    if (error.stderr) {
        // assimp's own reason, without our temp paths
        const line = error.stderr.split('\n').map((l) => l.trim())
            .filter((l) => l && !/^Launching|^Info,|^Debug,/i.test(l)).pop() || '';
        return { status: 422, text: `FBX conversion failed: ${line.replace(/\/\S*beestoon-editor-fbx-\S*/g, '').slice(0, 200) || 'the converter rejected this model'}` };
    }

    return { status: 500, text: 'FBX export failed on the server. Please try again, or export GLB.' };
}


/*
 * assimp's binary FBX says UnitScaleFactor 1 (cm); the data
 * is in metres. Both unit properties become 100 (m), in
 * place (same 8-byte double): nothing else changes.
 */
export function fbxInMetres(fbx) {

    if (fbx.subarray(0, 18).toString('latin1') !== 'Kaydara FBX Binary') {
        return fbx;
    }

    for (const name of ['UnitScaleFactor', 'OriginalUnitScaleFactor']) {

        const tag = Buffer.concat([Buffer.from('S'), Buffer.alloc(4), Buffer.from(name)]);
        tag.writeUInt32LE(name.length, 1);

        let at = fbx.indexOf(tag);

        while (at !== -1) {

            // "double", "Number", "" then the value
            let i = at + tag.length;
            let ok = true;

            for (let k = 0; k < 3 && ok; k++) {
                ok = fbx[i] === 0x53;   // 'S'
                i += ok ? 5 + fbx.readUInt32LE(i + 1) : 0;
            }

            if (ok && fbx[i] === 0x44) {   // 'D'
                fbx.writeDoubleLE(100, i + 1);
            }

            at = fbx.indexOf(tag, at + 1);
        }
    }

    return fbx;
}


// Is assimp there (GET / reports it; checked once at start-up)
let assimpState = 'unknown';

export function fbxExportStatus() {
    return assimpState;
}

function checkAssimp() {
    const child = spawn(ASSIMP_BIN, ['version'], { stdio: 'ignore' });
    child.on('error', () => { assimpState = 'missing'; console.warn('[export-fbx] assimp not found: FBX export is unavailable'); });
    child.on('close', (code) => { if (assimpState === 'unknown') assimpState = code === 0 ? 'available' : 'broken'; });
}


function runAssimp(args, cwd) {

    return new Promise((resolve, reject) => {

        const child = spawn(ASSIMP_BIN, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';

        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-2000);
        });


        // Kill the process itself on timeout, so a stuck
        // export cannot keep running in the background.
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            reject(Object.assign(new Error(`timed out after ${EXPORT_TIMEOUT_MS} ms`), { timedOut: true }));
        }, EXPORT_TIMEOUT_MS);


        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                return;
            }
            if (code === 0) {
                resolve();
            } else if (signal) {
                // Killed from outside (e.g. out of memory)
                reject(Object.assign(new Error(`assimp killed by ${signal}: ${stderr.trim()}`), { signal }));
            } else {
                reject(Object.assign(new Error(`assimp exited with ${code}: ${stderr.trim()}`), { stderr }));
            }
        });
    });
}


// File name used inside the zip: letters, digits, - and _
function safeBaseName(name) {

    const base = String(name || 'model')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w\-]+/g, '_')
        .slice(0, 80);

    return base || 'model';
}


function formatMb(bytes) {

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
