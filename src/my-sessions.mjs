/*
 * My sessions
 * --------------------------------------------------
 * The list on the start screen: every session a person
 * is in right now (any role), and every saved session
 * they own or were in. Opening one = its link
 * (?session=<sessionKey>), in the same tab.
 *
 * Who is asking comes from the identity adapter, the
 * same as joining a room:
 *   AUTH_PROVIDER=jwt  Authorization: Bearer <BeeStoon token>
 *   AUTH_PROVIDER=dev  X-Identity: {"userId":"...","name":"..."}
 *                      (the browser's fixed test account)
 *
 * GET    /sessions/mine
 *   { live: [...], saved: [...] }   see listFor()
 * DELETE /sessions/<sessionKey>
 *   Deletes a saved session with all its versions and
 *   model files. Owner only, and not while it is open.
 */

import { getAuthAdapter } from './auth/index.mjs';
import { deleteScene, sceneOfKey, scenesOfUser } from './scene-versions.mjs';
import { liveRoomOf, liveRooms, SESSION_KEY_PATTERN } from './sessions.mjs';


export function registerMySessionsRoutes(app) {

    app.use('/sessions', (req, res, next) => {

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-Identity, ngrok-skip-browser-warning'
        );

        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }

        next();
    });


    app.get('/sessions/mine', (req, res) => {

        handleList(req, res).catch((error) => fail(res, error));
    });

    app.delete('/sessions/:sessionKey', (req, res) => {

        handleDelete(req, res).catch((error) => fail(res, error));
    });
}


async function identify(req, res) {

    const header = String(req.headers.authorization || '');

    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    let identity = null;

    try {
        identity = JSON.parse(String(req.headers['x-identity'] || 'null'));
    } catch {
        // checked by the adapter
    }

    try {
        return await getAuthAdapter().verify({ token, options: { identity } });
    } catch (error) {
        res.status(401).send(`Login failed: ${error.message}`);
        return null;
    }
}


async function handleList(req, res) {

    const me = await identify(req, res);

    if (!me) {
        return;
    }

    res.setHeader('Cache-Control', 'no-store');

    res.json(await listFor(me.userId));
}


/*
 * live:  [{ sessionKey, sessionName, sessionType, role,
 *           owner, isOwner, people, online }]
 * saved: [{ sessionKey, name, sessionType, owner, isOwner,
 *           createdAt, lastActivity, live, versionCount,
 *           latest: { name, description, createdAt, savedBy },
 *           attendees: [{ name, role, lastSeen, isOwner }] }]
 */
export async function listFor(userId) {

    const live = [];

    for (const room of liveRooms()) {

        const user = room.users?.get(userId);

        if (!user || user.status !== 'approved' || room.closed) {
            continue;
        }

        live.push({
            sessionKey: room.sessionKey,
            sessionName: room.sessionName,
            sessionType: room.sessionType,
            role: user.role,
            owner: room.owner ? { name: room.owner.name } : null,
            isOwner: room.owner?.userId === userId,
            people: [...room.users.values()].filter((u) => u.status === 'approved').length,
            online: room.onlineUsers().length
        });
    }


    const saved = [];

    for (const scene of await scenesOfUser(userId)) {

        const latest = scene.versions[scene.versions.length - 1] || null;

        saved.push({
            sessionKey: scene.sessionKey,
            name: scene.name,
            sessionType: scene.sessionType,
            owner: { name: scene.owner.name },
            isOwner: scene.owner.userId === userId,
            createdAt: scene.createdAt,
            lastActivity: scene.lastActivity,
            live: !!liveRoomOf(scene.sessionKey),
            versionCount: scene.versions.length,
            latest: latest && {
                name: latest.name,
                description: latest.description,
                createdAt: latest.createdAt,
                savedBy: { name: latest.savedBy?.name }
            },
            attendees: Object.entries(scene.attendees)
                .map(([id, a]) => ({
                    name: a.name,
                    role: a.role,
                    lastSeen: a.lastSeen,
                    isOwner: id === scene.owner.userId
                }))
                .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
        });
    }

    return { live, saved };
}


async function handleDelete(req, res) {

    const me = await identify(req, res);

    if (!me) {
        return;
    }

    const { sessionKey } = req.params;

    if (!SESSION_KEY_PATTERN.test(sessionKey)) {
        res.status(404).send('Unknown session');
        return;
    }

    const scene = await sceneOfKey(sessionKey);

    if (!scene) {
        res.status(404).send('Unknown session');
        return;
    }

    if (scene.owner.userId !== me.userId) {
        res.status(403).send(`Only its owner (${scene.owner.name}) can delete this session`);
        return;
    }

    if (liveRoomOf(sessionKey)) {
        res.status(409).send('This session is open right now. Close it first, then delete it.');
        return;
    }

    await deleteScene(scene.sceneId);

    console.log(`[sessions] ${me.name} deleted saved session "${scene.name}" (${sessionKey})`);

    res.json({ deleted: sessionKey });
}


function fail(res, error) {

    console.error('[sessions]', error);

    if (!res.headersSent) {
        res.status(500).send('Could not read the saved sessions, please try again');
    }
}
