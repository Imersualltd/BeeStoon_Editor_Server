/*
 * Storage for saved scenes and their versions
 * --------------------------------------------------
 * A plain file store: put / get / list / remove by key
 * (a relative path like "<sceneId>/index.json"). What
 * the files mean is up to scene-versions.mjs.
 *
 * SCENE_STORAGE picks where they live (default: the
 * same as AR_STORAGE, so one setting covers both):
 *
 *   local (default)  a folder on this machine
 *                    (SCENE_LOCAL_DIR, default <tmp>/beestoon-editor-scenes).
 *                    Fine for development, but on Render the
 *                    folder is wiped on every redeploy, so
 *                    saved scenes are lost too.
 *
 *   s3               any S3-compatible bucket, e.g.
 *                    DigitalOcean Spaces. Uses the same
 *                    S3_ENDPOINT / S3_REGION / S3_BUCKET /
 *                    S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *                    as the AR links, with its own
 *                    SCENE_S3_PREFIX (default "scenes/").
 *                    The bucket stays private: model downloads
 *                    get a short-lived signed link straight to
 *                    the bucket (so the data does not flow
 *                    through this server), which needs CORS on
 *                    the bucket for the PlayCanvas page (see
 *                    README).
 *
 * Interface:
 *   put(key, body)  get(key)  exists(key)  sizeOf(key)  list(folderKey)
 *   remove([keys])  signedUrl(key, seconds)  (s3 only, else null)
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';


// Keys are made by scene-versions.mjs, but check them
// anyway so a bad key can never leave the folder.
const KEY_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

let storage = null;


export function getSceneStorage() {

    if (storage) {
        return storage;
    }

    const kind = (process.env.SCENE_STORAGE || process.env.AR_STORAGE || 'local').toLowerCase();

    if (kind === 's3') {
        storage = createS3Storage();
    } else if (kind === 'local') {
        storage = createLocalStorage();
    } else {
        throw new Error(`Unknown SCENE_STORAGE "${kind}" (use local or s3)`);
    }

    console.log(`Saved scenes stored in: ${storage.describe}`);

    return storage;
}


function checkKey(key) {

    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.includes('..')) {
        throw new Error(`Bad storage key "${key}"`);
    }

    return key;
}


// ==================================================
// LOCAL FOLDER
// ==================================================

function createLocalStorage() {

    const root = process.env.SCENE_LOCAL_DIR || path.join(tmpdir(), 'beestoon-editor-scenes');

    const fileOf = (key) => path.join(root, ...checkKey(key).split('/'));

    return {

        kind: 'local',

        describe: `local folder ${root}`,

        async put(key, body) {
            const file = fileOf(key);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, body);
        },

        // Buffer, or null when there is no such file
        async get(key) {
            try {
                return await readFile(fileOf(key));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        },

        async exists(key) {
            try {
                await stat(fileOf(key));
                return true;
            } catch {
                return false;
            }
        },

        async sizeOf(key) {
            try {
                return (await stat(fileOf(key))).size;
            } catch {
                return null;
            }
        },

        // The server streams local files itself
        async signedUrl() {
            return null;
        },

        // File names directly inside a folder key
        async list(prefix) {
            try {
                return await readdir(fileOf(prefix));
            } catch {
                return [];
            }
        },

        async remove(keys) {
            for (const key of keys) {
                await rm(fileOf(key), { force: true });
            }
        }
    };
}


// ==================================================
// S3 / DIGITALOCEAN SPACES
// ==================================================

function createS3Storage() {

    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    const missing = required.filter((name) => !process.env[name]);

    if (missing.length) {
        throw new Error(`SCENE_STORAGE=s3 needs: ${missing.join(', ')}`);
    }


    // Loaded only when s3 is used, so local development
    // starts fast.
    let s3Module = null;
    let client = null;

    async function s3() {

        if (!client) {
            s3Module = await import('@aws-sdk/client-s3');

            client = new s3Module.S3Client({
                endpoint: process.env.S3_ENDPOINT,
                region: process.env.S3_REGION || 'us-east-1',
                credentials: {
                    accessKeyId: process.env.S3_ACCESS_KEY_ID,
                    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
                }
            });
        }

        return { client, s3Module };
    }


    const bucket = process.env.S3_BUCKET;
    const prefix = process.env.SCENE_S3_PREFIX ?? 'scenes/';

    const objectKey = (key) => prefix + checkKey(key);


    return {

        kind: 's3',

        describe: `bucket ${bucket} (${process.env.S3_ENDPOINT}), prefix "${prefix}"`,

        async put(key, body) {

            const { client, s3Module } = await s3();

            await client.send(new s3Module.PutObjectCommand({
                Bucket: bucket,
                Key: objectKey(key),
                Body: body,
                ContentType: contentTypeOf(key),
                ACL: 'private'
            }));
        },

        async get(key) {

            const { client, s3Module } = await s3();

            try {
                const reply = await client.send(new s3Module.GetObjectCommand({
                    Bucket: bucket,
                    Key: objectKey(key)
                }));

                return Buffer.from(await reply.Body.transformToByteArray());

            } catch (error) {

                if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
                    return null;
                }

                throw error;
            }
        },

        async exists(key) {

            const { client, s3Module } = await s3();

            try {
                await client.send(new s3Module.HeadObjectCommand({
                    Bucket: bucket,
                    Key: objectKey(key)
                }));

                return true;

            } catch (error) {

                if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
                    return false;
                }

                throw error;
            }
        },

        async sizeOf(key) {

            const { client, s3Module } = await s3();

            try {
                const head = await client.send(new s3Module.HeadObjectCommand({
                    Bucket: bucket,
                    Key: objectKey(key)
                }));

                return head.ContentLength ?? null;

            } catch (error) {

                if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
                    return null;
                }

                throw error;
            }
        },

        // Short-lived link straight to the bucket
        async signedUrl(key, seconds) {

            const { client, s3Module } = await s3();
            const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

            return getSignedUrl(
                client,
                new s3Module.GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
                { expiresIn: seconds }
            );
        },

        async list(folder) {

            const { client, s3Module } = await s3();

            const start = objectKey(folder) + '/';
            const names = [];
            let token;

            do {
                const page = await client.send(new s3Module.ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: start,
                    ContinuationToken: token
                }));

                for (const item of page.Contents || []) {
                    const name = item.Key.slice(start.length);
                    if (name && !name.includes('/')) {
                        names.push(name);
                    }
                }

                token = page.IsTruncated ? page.NextContinuationToken : undefined;

            } while (token);

            return names;
        },

        async remove(keys) {

            if (!keys.length) {
                return;
            }

            const { client, s3Module } = await s3();

            await client.send(new s3Module.DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: keys.map((key) => ({ Key: objectKey(key) })),
                    Quiet: true
                }
            }));
        }
    };
}


function contentTypeOf(key) {

    if (key.endsWith('.json')) {
        return 'application/json';
    }

    if (key.endsWith('.glb')) {
        return 'model/gltf-binary';
    }

    return 'application/octet-stream';
}
