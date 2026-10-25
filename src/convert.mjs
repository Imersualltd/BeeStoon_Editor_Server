/*
 * FBX -> GLB conversion endpoint
 * --------------------------------------------------
 * POST /convert?name=<original file name>
 * Body:  the raw FBX bytes (application/octet-stream)
 * Reply: the converted GLB bytes (model/gltf-binary)
 *        or a short plain-text error.
 *
 * Used by model-converter.mjs in the PlayCanvas
 * project. The browser cannot read FBX reliably, so
 * it sends the file here, gets a GLB back and then
 * loads / shares that GLB like a normal GLB upload.
 *
 * The uploaded file is untrusted: it is size-limited,
 * type-checked, written to its own temp folder under
 * a fixed name and always deleted afterwards.
 */

import express from 'express';

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir, type as osType } from 'node:os';
import path from 'node:path';

import { requireEditor } from './sessions.mjs';


// Must match MAX_UPLOAD_SIZE in model-converter.mjs
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Give up if the converter takes longer than this
const CONVERT_TIMEOUT_MS = 90 * 1000;


// Small free instance: one conversion at a time
let busy = false;

// Loaded on first use so the multiplayer server
// still starts if the converter is missing.
let convertFbx = null;


export function registerConvertRoute(app) {

    /*
     * The PlayCanvas launch page runs on another
     * origin, so the browser needs CORS headers and
     * an answer to the OPTIONS preflight.
     */
    app.use('/convert', (req, res, next) => {

        res.setHeader('Access-Control-Allow-Origin', '*');
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
        '/convert',
        requireEditor,
        express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
        handleConvert
    );


    // Body larger than the limit -> clear 413 text
    app.use('/convert', (error, req, res, next) => {

        if (error?.type === 'entity.too.large') {
            res.status(413).send('File is too big (max 50 MB)');
            return;
        }

        next(error);
    });


    console.log('FBX -> GLB converter ready at POST /convert');
}


async function handleConvert(req, res) {

    const originalName =
        String(req.query.name || 'model.fbx').slice(0, 200);

    const body = req.body;


    // ==============================================
    // VALIDATE
    // ==============================================

    if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).send('Empty upload');
        return;
    }

    if (!originalName.toLowerCase().endsWith('.fbx')) {
        res.status(415).send('Only .fbx files can be converted');
        return;
    }

    if (!looksLikeFbx(body)) {
        res.status(415).send('File is not a valid FBX');
        return;
    }

    if (busy) {
        res.status(503).send('Converter is busy, try again in a moment');
        return;
    }


    let convert;

    try {
        convert = await loadConverter();
    } catch (error) {
        console.error('fbx2gltf could not be loaded:', error);
        res.status(501).send('FBX converter is not installed on the server');
        return;
    }


    // ==============================================
    // CONVERT
    // ==============================================

    busy = true;

    // The user's file name is never used on disk
    const workDir = path.join(tmpdir(), `be-water-convert-${randomUUID()}`);
    const inputPath = path.join(workDir, 'input.fbx');

    // Must end in lower-case ".glb" for binary output
    const outputPath = path.join(workDir, 'output.glb');

    const started = Date.now();


    try {

        await mkdir(workDir, { recursive: true });
        await writeFile(inputPath, body);

        console.log(`[convert] ${originalName} (${formatMb(body.length)})...`);

        await withTimeout(
            convert(inputPath, outputPath, []),
            CONVERT_TIMEOUT_MS
        );

        const glb = await readFile(outputPath);

        console.log(
            `[convert] done ${originalName} -> ${formatMb(glb.length)} ` +
            `in ${((Date.now() - started) / 1000).toFixed(1)}s`
        );

        res.setHeader('Content-Type', 'model/gltf-binary');
        res.send(glb);

    } catch (error) {

        console.error(`[convert] failed for ${originalName}:`, error);

        res.status(500).send('Conversion failed');

    } finally {

        busy = false;

        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}


async function loadConverter() {

    if (convertFbx) {
        return convertFbx;
    }


    const mod = await import('fbx2gltf');

    convertFbx = mod.default ?? mod;


    /*
     * The package ships prebuilt binaries per OS.
     * Make sure the Linux/macOS one is executable
     * (some installs drop the exec bit).
     */
    if (process.platform !== 'win32') {

        try {
            const require = createRequire(import.meta.url);
            const pkgDir = path.dirname(require.resolve('fbx2gltf/package.json'));
            const binary = path.join(pkgDir, 'bin', osType(), 'FBX2glTF');

            await chmod(binary, 0o755);
        } catch (error) {
            console.warn('[convert] could not chmod FBX2glTF binary:', error.message);
        }
    }


    return convertFbx;
}


/*
 * Binary FBX starts with "Kaydara FBX Binary".
 * ASCII FBX has an "FBX" header comment.
 */
function looksLikeFbx(data) {

    const head = data.subarray(0, 64).toString('latin1');

    return (
        head.startsWith('Kaydara FBX Binary') ||
        head.includes('FBX')
    );
}


function withTimeout(promise, ms) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(
            () => reject(new Error(`Timed out after ${ms} ms`)),
            ms
        );

        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}


function formatMb(bytes) {

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
