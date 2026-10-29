/*
 * Storage for AR snapshots
 * --------------------------------------------------
 * Each snapshot is two files under one id:
 *   <id>/model.glb   the 3D model
 *   <id>/meta.json   { id, name, size, createdAt, expiresAt }
 *
 * AR_STORAGE picks where they live:
 *
 *   local (default)  a folder on this machine
 *                    (AR_LOCAL_DIR, default <tmp>/beestoon-editor-ar).
 *                    Fine for development and Render's free
 *                    plan, but the folder is wiped on every
 *                    redeploy.
 *
 *   s3               any S3-compatible bucket, e.g.
 *                    DigitalOcean Spaces:
 *                      S3_ENDPOINT  https://fra1.digitaloceanspaces.com
 *                      S3_REGION    fra1 (Spaces ignores it, AWS needs it)
 *                      S3_BUCKET    bucket (Space) name
 *                      S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *                      S3_PREFIX    optional, default "ar-snapshots/"
 *                    The bucket stays private: the server reads
 *                    the files and streams them to the phone.
 *
 * All providers have the same small interface:
 *   put(id, glbBuffer, meta)  getMeta(id)  getModelStream(id)
 *   remove(id)  listIds()
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';


let storage = null;


export function getArStorage() {

    if (storage) {
        return storage;
    }

    const kind = (process.env.AR_STORAGE || 'local').toLowerCase();

    if (kind === 's3') {
        storage = createS3Storage();
    } else if (kind === 'local') {
        storage = createLocalStorage();
    } else {
        throw new Error(`Unknown AR_STORAGE "${kind}" (use local or s3)`);
    }

    console.log(`AR snapshots stored in: ${storage.describe}`);

    return storage;
}


// ==================================================
// LOCAL FOLDER
// ==================================================

function createLocalStorage() {

    const root = process.env.AR_LOCAL_DIR || path.join(tmpdir(), 'beestoon-editor-ar');

    const dirOf = (id) => path.join(root, id);

    return {

        describe: `local folder ${root}`,

        async put(id, glb, meta) {
            await mkdir(dirOf(id), { recursive: true });
            await writeFile(path.join(dirOf(id), 'model.glb'), glb);
            await writeFile(path.join(dirOf(id), 'meta.json'), JSON.stringify(meta));
        },

        async getMeta(id) {
            try {
                return JSON.parse(await readFile(path.join(dirOf(id), 'meta.json'), 'utf8'));
            } catch {
                return null;
            }
        },

        async getModelStream(id) {
            return createReadStream(path.join(dirOf(id), 'model.glb'));
        },

        async remove(id) {
            await rm(dirOf(id), { recursive: true, force: true });
        },

        async listIds() {
            try {
                return await readdir(root);
            } catch {
                return [];
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
        throw new Error(`AR_STORAGE=s3 needs: ${missing.join(', ')}`);
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
    const prefix = process.env.S3_PREFIX ?? 'ar-snapshots/';

    const keyOf = (id, file) => `${prefix}${id}/${file}`;


    return {

        describe: `bucket ${bucket} (${process.env.S3_ENDPOINT}), prefix "${prefix}"`,

        async put(id, glb, meta) {

            const { client, s3Module } = await s3();

            await client.send(new s3Module.PutObjectCommand({
                Bucket: bucket,
                Key: keyOf(id, 'model.glb'),
                Body: glb,
                ContentType: 'model/gltf-binary',
                ACL: 'private'
            }));

            await client.send(new s3Module.PutObjectCommand({
                Bucket: bucket,
                Key: keyOf(id, 'meta.json'),
                Body: JSON.stringify(meta),
                ContentType: 'application/json',
                ACL: 'private'
            }));
        },

        async getMeta(id) {

            const { client, s3Module } = await s3();

            try {
                const reply = await client.send(new s3Module.GetObjectCommand({
                    Bucket: bucket,
                    Key: keyOf(id, 'meta.json')
                }));

                return JSON.parse(await reply.Body.transformToString());

            } catch (error) {

                if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
                    return null;
                }

                throw error;
            }
        },

        async getModelStream(id) {

            const { client, s3Module } = await s3();

            const reply = await client.send(new s3Module.GetObjectCommand({
                Bucket: bucket,
                Key: keyOf(id, 'model.glb')
            }));

            return reply.Body;
        },

        async remove(id) {

            const { client, s3Module } = await s3();

            await client.send(new s3Module.DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: [
                        { Key: keyOf(id, 'model.glb') },
                        { Key: keyOf(id, 'meta.json') }
                    ],
                    Quiet: true
                }
            }));
        },

        async listIds() {

            const { client, s3Module } = await s3();

            const ids = new Set();
            let token;

            do {
                const page = await client.send(new s3Module.ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: token
                }));

                for (const item of page.Contents || []) {
                    const id = item.Key.slice(prefix.length).split('/')[0];
                    if (id) {
                        ids.add(id);
                    }
                }

                token = page.IsTruncated ? page.NextContinuationToken : undefined;

            } while (token);

            return [...ids];
        }
    };
}
