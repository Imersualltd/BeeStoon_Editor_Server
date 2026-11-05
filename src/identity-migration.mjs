/*
 * Existing editor data -> BeeStoon identities
 * --------------------------------------------------
 * Before the BeeStoon login, sessions were saved under
 * development ids (dev:<id>, e.g. dev:browser-..., the test
 * account of one browser) or, if JWT was ever used with the
 * site's own token, jwt:<email>. With the BeeStoon login every
 * person is jwt:<account UUID>, so those saved sessions would
 * belong to nobody.
 *
 * inventory(storage)            read only: saved sessions with
 *                               owner/attendee id kinds, and the
 *                               test wallets, listed separately
 * applyMapping(storage, map,    rewrites ONLY the ids in `map`
 *   { apply, backupPrefix })    ({ "<old id>": "jwt:<uuid>" }) in
 *                               scene.json, version files and the
 *                               people's session lists. Dry run
 *                               unless apply. Every changed file is
 *                               copied to <backupPrefix>/... first.
 *                               Nothing is deleted; wallets are
 *                               never read for writing (their
 *                               balances were test credits and are
 *                               not carried into BeeStoon).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;


export function kindOf(userId) {

    const id = String(userId || '');

    if (id.startsWith('jwt:')) {
        const sub = id.slice(4);
        if (UUID.test(sub)) return 'beestoon-account';
        if (EMAIL.test(sub)) return 'site-email';
        return 'other-jwt';
    }

    if (id.startsWith('dev:browser-')) return 'test-browser';
    if (id.startsWith('dev:as-')) return 'test-name';
    if (id.startsWith('dev:pc-')) return 'playcanvas-user';
    if (id.startsWith('dev:')) return 'dev';

    return 'unknown';
}


// Kinds that need a person to say who they are
export const NEEDS_INPUT = ['test-browser', 'test-name', 'playcanvas-user', 'dev', 'other-jwt', 'unknown'];


async function readJson(storage, key) {

    const body = await storage.get(key);

    return body ? JSON.parse(body.toString('utf8')) : null;
}


function userListKey(userId) {

    return `users/${Buffer.from(String(userId)).toString('base64url')}/scenes.json`;
}


export async function inventory(storage) {

    const scenes = [];
    const people = new Map();

    const note = (userId, name, sceneId, as) => {
        const entry = people.get(userId) || { userId, kind: kindOf(userId), names: new Set(), scenes: new Set(), owns: 0 };
        if (name) entry.names.add(name);
        entry.scenes.add(sceneId);
        if (as === 'owner') entry.owns += 1;
        people.set(userId, entry);
    };

    for (const file of await storage.list('keys')) {

        const link = await readJson(storage, `keys/${file}`);
        const scene = link?.sceneId ? await readJson(storage, `${link.sceneId}/scene.json`) : null;

        if (!scene) {
            continue;
        }

        let bytes = 0;
        for (const blob of await storage.list(`${scene.sceneId}/blobs`)) {
            bytes += (await storage.sizeOf(`${scene.sceneId}/blobs/${blob}`)) || 0;
        }

        note(scene.owner?.userId, scene.owner?.name, scene.sceneId, 'owner');
        for (const [userId, attendee] of Object.entries(scene.attendees || {})) {
            note(userId, attendee?.name, scene.sceneId, 'attendee');
        }

        scenes.push({
            sceneId: scene.sceneId,
            sessionKey: scene.sessionKey,
            name: scene.name,
            sessionType: scene.sessionType,
            owner: { userId: scene.owner?.userId, name: scene.owner?.name, kind: kindOf(scene.owner?.userId) },
            attendees: Object.keys(scene.attendees || {}).length,
            versions: (scene.versions || []).length,
            lastActivity: scene.lastActivity,
            storedBytes: bytes,
            pool: scene.credits ? { total: scene.credits.total, left: scene.credits.left } : null
        });
    }

    const wallets = [];
    for (const file of await storage.list('wallets')) {
        const wallet = await readJson(storage, `wallets/${file}`);
        if (wallet) {
            wallets.push({ userId: wallet.userId, kind: kindOf(wallet.userId), balance: wallet.balance,
                           entries: (wallet.history || []).length });
        }
    }

    const list = [...people.values()].map((p) => ({
        userId: p.userId, kind: p.kind, names: [...p.names], sessions: p.scenes.size, owns: p.owns,
        needsInput: NEEDS_INPUT.includes(p.kind)
    }));

    return { scenes, people: list, wallets };
}


function checkMapping(map, known) {

    const problems = [];

    for (const [from, to] of Object.entries(map || {})) {
        if (!known.has(from)) problems.push(`${from}: not found in the saved sessions`);
        if (!/^jwt:[0-9a-f-]{36}$/i.test(String(to)) || !UUID.test(String(to).slice(4))) {
            problems.push(`${from}: target must be jwt:<BeeStoon account UUID>`);
        }
        if (kindOf(from) === 'beestoon-account') problems.push(`${from}: already a BeeStoon account`);
    }

    return problems;
}


const swap = (map, id) => (id && Object.hasOwn(map, id) ? map[id] : id);


export async function applyMapping(storage, map, { apply = false, backupPrefix = null } = {}) {

    const { scenes, people } = await inventory(storage);
    const problems = checkMapping(map, new Set(people.map((p) => p.userId)));

    if (problems.length) {
        return { ok: false, problems, changes: [] };
    }

    if (apply && !backupPrefix) {
        throw new Error('applying needs a backup prefix');
    }

    const changes = [];
    const writes = new Map();   // key -> new JSON

    for (const summary of scenes) {

        const sceneKey = `${summary.sceneId}/scene.json`;
        const scene = await readJson(storage, sceneKey);
        const before = JSON.stringify(scene);

        if (scene.owner) scene.owner.userId = swap(map, scene.owner.userId);

        const attendees = {};
        for (const [userId, attendee] of Object.entries(scene.attendees || {})) {
            const target = swap(map, userId);
            // Already in the session under the new id: keep that entry
            attendees[target] = attendees[target] || scene.attendees[target] || attendee;
        }
        scene.attendees = attendees;

        for (const version of scene.versions || []) {
            if (version.savedBy) version.savedBy.userId = swap(map, version.savedBy.userId);
        }

        if (JSON.stringify(scene) !== before) {
            writes.set(sceneKey, scene);
            changes.push(`${sceneKey}: owner/attendees/savedBy`);
        }

        for (const file of await storage.list(`${summary.sceneId}/versions`)) {
            const key = `${summary.sceneId}/versions/${file}`;
            const version = await readJson(storage, key);
            const was = JSON.stringify(version);
            if (version.savedBy) version.savedBy.userId = swap(map, version.savedBy.userId);
            for (const object of version.objects || []) {
                object.addedBy = swap(map, object.addedBy);
                object.assignedTo = swap(map, object.assignedTo);
            }
            if (JSON.stringify(version) !== was) {
                writes.set(key, version);
                changes.push(`${key}: savedBy/addedBy/assignedTo`);
            }
        }
    }

    // Each person's list of saved sessions: merged into the new id's
    // list; the old list stays where it is
    for (const [from, to] of Object.entries(map)) {
        const old = (await readJson(storage, userListKey(from))) || [];
        if (!old.length) continue;
        const targetKey = userListKey(to);
        const target = writes.get(targetKey) || (await readJson(storage, targetKey)) || [];
        for (const entry of old) {
            if (!target.some((e) => e.sceneId === entry.sceneId)) {
                target.push({ ...entry });
            }
        }
        writes.set(targetKey, target);
        changes.push(`${targetKey}: + ${old.length} session(s) of ${from}`);
    }

    if (apply) {
        for (const key of writes.keys()) {
            const current = await storage.get(key);
            if (current) {
                await storage.put(`${backupPrefix}/${key}`, current);
            }
        }
        for (const [key, value] of writes) {
            await storage.put(key, Buffer.from(JSON.stringify(value, null, 2)));
        }
    }

    return { ok: true, problems: [], changes, applied: apply };
}
