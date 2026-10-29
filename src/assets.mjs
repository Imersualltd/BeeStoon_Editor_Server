/*
 * Model files of a session
 * --------------------------------------------------
 * Models no longer travel through the session as text
 * (data URLs kept in server memory). The editor uploads
 * the GLB once, then shares only its id:
 *
 *   1. POST /assets?name=<file name>
 *        Body:  GLB bytes (application/octet-stream)
 *        Auth:  Authorization: Bearer <session ticket>
 *               (admins and editors)
 *        Reply: { assetId, size, url }
 *      Refused with 413 when the file or the session
 *      would go over its type's limit (session-types.mjs).
 *
 *   2. room message 'object:add' { id, name, assetId, transform? }
 *      Everyone receives { ..., assetId, size, url }.
 *
 *   3. GET /assets/<sceneId>/<assetId>.glb
 *      The model. With S3/Spaces storage this redirects
 *      to a short-lived signed link, so the download
 *      comes from the bucket and not through this server.
 *
 * Files are stored once per scene by content (sha256),
 * so the same model imported twice, or kept in many
 * saved versions later, is stored and counted once.
 * They live in scene storage (scene-storage.mjs) under
 * <sceneId>/blobs/<assetId>.glb.
 *
 * The sceneId is a long random id, made when the
 * session starts. A model link works for anyone who has
 * it, like the AR links; only session members get them.
 */

import express from 'express';

import { createHash } from 'node:crypto';

import { baseUrl } from './ar-share.mjs';
import { getSceneStorage } from './scene-storage.mjs';
import { requireEditor } from './sessions.mjs';
import { SESSION_TYPES } from './session-types.mjs';


// The biggest file any session type allows
const MAX_UPLOAD_BYTES = Math.max(
    ...Object.values(SESSION_TYPES).map((type) => type.fileBytes)
);

const SIGNED_URL_SECONDS = 3600;

const GLB_MAGIC = 0x46546C67;          // "glTF"

export const SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

export const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;


export function blobKey(sceneId, assetId) {

    return `${sceneId}/blobs/${assetId}.glb`;
}


export function registerAssetRoutes(app) {

    // Fails at start-up when the storage settings are wrong
    const storage = getSceneStorage();


    app.use('/assets', (req, res, next) => {

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
        '/assets',
        requireEditor,
        express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
        (req, res) => handleUpload(req, res, storage).catch((error) => fail(res, error))
    );

    app.get(
        '/assets/:sceneId/:file',
        (req, res) => handleDownload(req, res, storage).catch((error) => fail(res, error))
    );


    app.use('/assets', (error, req, res, next) => {

        if (error?.type === 'entity.too.large') {
            res.status(413).send(`Model file is too big (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
            return;
        }

        next(error);
    });


    console.log(`Model files ready at POST /assets (stored in ${storage.describe})`);
}


// ==================================================
// HANDLERS
// ==================================================

async function handleUpload(req, res, storage) {

    const room = req.session.room;

    const body = req.body;

    if (!Buffer.isBuffer(body) || body.length < 20) {
        res.status(400).send('Empty upload');
        return;
    }

    if (body.readUInt32LE(0) !== GLB_MAGIC || body.readUInt32LE(4) !== 2) {
        res.status(415).send('Not a GLB (glTF 2.0 binary) file');
        return;
    }


    const assetId = createHash('sha256').update(body).digest('hex');

    // Over the file or session limit of this session type
    const reason = room.uploadDenial(assetId, body.length);

    if (reason) {
        res.status(413).send(reason);
        return;
    }


    const key = blobKey(room.sceneId, assetId);

    if (!(await storage.exists(key))) {
        await storage.put(key, body);
    }


    const url = `${baseUrl(req)}/assets/${room.sceneId}/${assetId}.glb`;

    room.registerUpload(assetId, body.length, url);


    console.log(
        `[${room.roomId}] upload ${String(req.query.name || 'model').slice(0, 80)} ` +
        `(${(body.length / 1048576).toFixed(1)} MB) ${assetId.slice(0, 8)}`
    );

    res.json({ assetId, size: body.length, url });
}


async function handleDownload(req, res, storage) {

    const { sceneId, file } = req.params;

    const assetId = file.endsWith('.glb') ? file.slice(0, -4) : '';

    if (!SCENE_ID_PATTERN.test(sceneId) || !ASSET_ID_PATTERN.test(assetId)) {
        res.status(404).send('Not found');
        return;
    }


    const key = blobKey(sceneId, assetId);

    // S3 / Spaces: let the bucket send it
    const signed = await storage.signedUrl(key, SIGNED_URL_SECONDS);

    if (signed) {
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, signed);
        return;
    }


    const body = await storage.get(key);

    if (!body) {
        res.status(404).send('Not found');
        return;
    }

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Length', String(body.length));

    // Same id = same bytes, forever
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

    res.send(body);
}


function fail(res, error) {

    console.error('[assets]', error);

    if (!res.headersSent) {
        res.status(500).send('Model file storage failed, please try again');
    } else {
        res.destroy();
    }
}
