/*
 * Saved sessions and their versions
 * --------------------------------------------------
 * A session becomes a saved session the first time it
 * is saved (by hand or by autosave). It stays until its
 * owner (the person who created it) deletes it.
 *
 * Files in scene storage (scene-storage.mjs):
 *
 *   <sceneId>/scene.json            the saved session:
 *       { sceneId, sessionKey, name, sessionType,
 *         owner: { userId, name }, createdAt, lastActivity,
 *         attendees: { userId: { name, role, lastSeen } },
 *         versions: [summary, ...] (oldest first) }
 *   <sceneId>/versions/<id>.json    one version:
 *       { ...summary, objects: [{ id, name, assetId, size,
 *         url, transform, addedBy, assignedTo }] }
 *   <sceneId>/blobs/<assetId>.glb   model files (assets.mjs)
 *   keys/<sessionKey>.json          { sceneId }: the link ->
 *                                   saved session
 *   users/<user>/scenes.json        [{ sceneId, owner }]:
 *                                   saved sessions a person
 *                                   owns or was in
 *
 * A version summary:
 *   { id, name, description, auto, createdAt,
 *     savedBy: { userId, name }, objectCount, bytes }
 *
 * Model files are shared between versions (stored once
 * by content), so a version is mostly a small JSON file.
 *
 * Limits: the last AUTOSAVES_KEPT autosaves and up to
 * MAX_NAMED_VERSIONS named versions per saved session;
 * SAVED_SESSIONS_PER_TYPE saved sessions per owner and
 * session type (SAVED_SESSIONS_LIMIT env overrides all
 * three, e.g. for tests).
 */

import { createHash, randomBytes } from 'node:crypto';

import { blobKey } from './assets.mjs';
import { getSceneStorage } from './scene-storage.mjs';


export const AUTOSAVES_KEPT = 20;

export const MAX_NAMED_VERSIONS = 50;

// Saved sessions one person may own, per session type
export const SAVED_SESSIONS_PER_TYPE = {
    single: 10,
    basic: 10,
    workshop: 5
};

export const MAX_VERSION_NAME = 80;

export const MAX_VERSION_DESCRIPTION = 500;


// One write at a time per saved session (and per
// person index), so two saves never overwrite each other
const queues = new Map();

function queued(key, task) {

    const previous = queues.get(key) || Promise.resolve();

    const next = previous.catch(() => {}).then(task);

    queues.set(key, next);

    next.finally(() => {
        if (queues.get(key) === next) {
            queues.delete(key);
        }
    }).catch(() => {});

    return next;
}


// ==================================================
// READING
// ==================================================

async function readJson(key) {

    const body = await getSceneStorage().get(key);

    return body ? JSON.parse(body.toString('utf8')) : null;
}


async function writeJson(key, value) {

    await getSceneStorage().put(key, Buffer.from(JSON.stringify(value)));
}


export async function loadScene(sceneId) {

    return readJson(`${sceneId}/scene.json`);
}


// The saved session behind a share link, or null
export async function sceneOfKey(sessionKey) {

    const entry = await readJson(`keys/${sessionKey}.json`);

    return entry ? loadScene(entry.sceneId) : null;
}


export async function loadVersion(sceneId, versionId) {

    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(versionId))) {
        return null;
    }

    return readJson(`${sceneId}/versions/${versionId}.json`);
}


export async function latestVersion(scene) {

    const last = scene?.versions?.[scene.versions.length - 1];

    return last ? loadVersion(scene.sceneId, last.id) : null;
}


// Saved sessions a person owns or was in, newest first
export async function scenesOfUser(userId) {

    const list = (await readJson(userKey(userId))) || [];

    const scenes = [];

    for (const entry of list) {

        const scene = await loadScene(entry.sceneId);

        if (scene) {
            scenes.push(scene);
        }
    }

    return scenes.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
}


export async function ownedCount(userId, sessionType) {

    const list = (await readJson(userKey(userId))) || [];

    let count = 0;

    for (const entry of list) {

        if (!entry.owner) {
            continue;
        }

        const scene = await loadScene(entry.sceneId);

        if (scene && scene.sessionType === sessionType) {
            count++;
        }
    }

    return count;
}


// ==================================================
// SAVING
// ==================================================

/*
 * Save the room's objects as a new version.
 *
 *   info: { sceneId, sessionKey, name, sessionType,
 *           owner: { userId, name }, attendees: {...},
 *           removed: [userId] (kicked), baseUrl }
 *   objects: the room's object records
 *   version: { name, description, auto, savedBy }
 *
 * Models that came as data URLs (older clients) are
 * stored as files first. Returns { scene, version }.
 * Throws an Error with .userMessage when the owner has
 * no saved-session place left.
 */
export function saveVersion(info, objects, version) {

    return queued(info.sceneId, async () => {

        const storage = getSceneStorage();

        let scene = await loadScene(info.sceneId);

        const isNew = !scene;


        if (isNew) {

            const limit = Number(process.env.SAVED_SESSIONS_LIMIT) ||
                (SAVED_SESSIONS_PER_TYPE[info.sessionType] ?? 10);

            const owned = await ownedCount(info.owner.userId, info.sessionType);

            if (owned >= limit) {

                const error = new Error('saved session limit');

                error.userMessage =
                    `${info.owner.name} already has ${owned} saved ${info.sessionType} sessions ` +
                    `(the limit is ${limit}). Delete one from My sessions to save this one.`;

                throw error;
            }


            scene = {
                sceneId: info.sceneId,
                sessionKey: info.sessionKey,
                name: info.name,
                sessionType: info.sessionType,
                owner: info.owner,
                createdAt: new Date().toISOString(),
                lastActivity: null,
                attendees: {},
                versions: []
            };
        }


        // Model files of this version
        const saved = [];

        let bytes = 0;

        const counted = new Set();

        for (const object of objects) {

            let { assetId, size, url } = object;

            if (!assetId && object.dataUrl) {

                const body = decodeDataUrl(object.dataUrl);

                assetId = createHash('sha256').update(body).digest('hex');
                size = body.length;
                url = info.baseUrl ? `${info.baseUrl}/assets/${info.sceneId}/${assetId}.glb` : null;

                const key = blobKey(info.sceneId, assetId);

                if (!(await storage.exists(key))) {
                    await storage.put(key, body);
                }
            }

            if (!assetId) {
                continue;
            }

            if (!counted.has(assetId)) {
                counted.add(assetId);
                bytes += size;
            }

            saved.push({
                id: object.id,
                name: object.name,
                assetId,
                size,
                url,
                transform: object.transform,
                addedBy: object.addedBy,
                assignedTo: object.assignedTo
            });
        }


        const now = new Date().toISOString();

        const summary = {
            id: newVersionId(),
            name: cleanText(version.name, MAX_VERSION_NAME) || (version.auto ? 'Autosave' : 'Version'),
            description: cleanText(version.description, MAX_VERSION_DESCRIPTION),
            auto: !!version.auto,
            createdAt: now,
            savedBy: version.savedBy,
            objectCount: saved.length,
            bytes
        };

        await writeJson(`${info.sceneId}/versions/${summary.id}.json`, { ...summary, objects: saved });


        // Keep the newest autosaves and named versions
        scene.versions.push(summary);

        const drop = [];

        const autos = scene.versions.filter((v) => v.auto);
        drop.push(...autos.slice(0, Math.max(0, autos.length - AUTOSAVES_KEPT)));

        const named = scene.versions.filter((v) => !v.auto);
        drop.push(...named.slice(0, Math.max(0, named.length - MAX_NAMED_VERSIONS)));

        if (drop.length) {

            scene.versions = scene.versions.filter((v) => !drop.includes(v));

            await storage.remove(drop.map((v) => `${info.sceneId}/versions/${v.id}.json`));
        }


        scene.name = info.name || scene.name;
        scene.lastActivity = now;

        for (const [userId, attendee] of Object.entries(info.attendees || {})) {
            scene.attendees[userId] = { ...scene.attendees[userId], ...attendee };
        }

        // Kicked people lose the saved session too
        for (const userId of info.removed || []) {

            if (scene.attendees[userId] && userId !== scene.owner.userId) {

                delete scene.attendees[userId];

                await removeFromUser(userId, info.sceneId);
            }
        }

        await writeJson(`${info.sceneId}/scene.json`, scene);


        if (isNew) {
            await writeJson(`keys/${info.sessionKey}.json`, { sceneId: info.sceneId });
        }

        // Everyone who was in it can find it in My sessions
        for (const userId of Object.keys(scene.attendees)) {
            await addToUser(userId, info.sceneId, userId === scene.owner.userId);
        }

        await addToUser(scene.owner.userId, info.sceneId, true);


        return { scene, version: summary };
    });
}


// Name, attendees, last activity - without a new version
export function updateScene(sceneId, changes) {

    return queued(sceneId, async () => {

        const scene = await loadScene(sceneId);

        if (!scene) {
            return null;
        }

        if (changes.name) {
            scene.name = changes.name;
        }

        for (const [userId, attendee] of Object.entries(changes.attendees || {})) {
            scene.attendees[userId] = { ...scene.attendees[userId], ...attendee };
        }

        scene.lastActivity = new Date().toISOString();

        await writeJson(`${sceneId}/scene.json`, scene);

        return scene;
    });
}


// ==================================================
// DELETING (owner only - the caller checks)
// ==================================================

export function deleteScene(sceneId) {

    return queued(sceneId, async () => {

        const storage = getSceneStorage();

        const scene = await loadScene(sceneId);

        if (!scene) {
            return false;
        }

        const versions = await storage.list(`${sceneId}/versions`);
        const blobs = await storage.list(`${sceneId}/blobs`);

        await storage.remove([
            ...versions.map((name) => `${sceneId}/versions/${name}`),
            ...blobs.map((name) => `${sceneId}/blobs/${name}`),
            `${sceneId}/scene.json`,
            `keys/${scene.sessionKey}.json`
        ]);

        const people = new Set([scene.owner.userId, ...Object.keys(scene.attendees)]);

        for (const userId of people) {
            await removeFromUser(userId, sceneId);
        }

        return true;
    });
}


// ==================================================
// PERSON INDEX
// ==================================================

// userIds look like "dev:tab-abc" or "jwt:123"
function userKey(userId) {

    return `users/${Buffer.from(String(userId)).toString('base64url')}/scenes.json`;
}


function addToUser(userId, sceneId, owner) {

    return queued(userKey(userId), async () => {

        const list = (await readJson(userKey(userId))) || [];

        const entry = list.find((e) => e.sceneId === sceneId);

        if (entry) {

            if (entry.owner === owner) {
                return;
            }

            entry.owner = owner;

        } else {
            list.push({ sceneId, owner });
        }

        await writeJson(userKey(userId), list);
    });
}


function removeFromUser(userId, sceneId) {

    return queued(userKey(userId), async () => {

        const list = (await readJson(userKey(userId))) || [];

        const kept = list.filter((e) => e.sceneId !== sceneId);

        if (kept.length !== list.length) {
            await writeJson(userKey(userId), kept);
        }
    });
}


// ==================================================
// HELPERS
// ==================================================

function newVersionId() {

    // Sorts by time, then random
    return Date.now().toString(36) + randomBytes(6).toString('base64url');
}


export function cleanText(value, max) {

    return typeof value === 'string'
        ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max)
        : '';
}


function decodeDataUrl(dataUrl) {

    const comma = dataUrl.indexOf(',');

    return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}
