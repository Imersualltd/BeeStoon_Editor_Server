/*
 * Session records
 * --------------------------------------------------
 * Who belongs to a session, kept in storage for every
 * session (saved or not):
 *
 *   { sessionKey, sceneId, owner: { userId, name },
 *     sessionName, sessionType,
 *     members: { <userId>: { name, role } },   approved people
 *     removed: [<userId>, ...],                removed by an admin
 *     closedByAdmin: <ISO time> | null,
 *     createdAt, updatedAt }
 *
 * Rooms live in the memory of one server process. Render
 * restarts that process on every deploy and when a free
 * instance spins down; before this record existed, the
 * room that came back had no owner, and whoever reconnected
 * first became its admin while the real owner waited for
 * approval. With the record, a room that comes back gives
 * the owner and every approved member their place and
 * role again, and removed people still ask the admin.
 *
 * No login tokens, emails or credits are stored here.
 */
import { queued, readJson, writeJson } from './scene-versions.mjs';


const recordKey = (sessionKey) => `records/${sessionKey}.json`;


export async function readRecord(sessionKey, { strict = false } = {}) {

    try {
        return await readJson(recordKey(sessionKey));
    } catch (error) {
        console.error(`Could not read the record of session ${sessionKey}: ${error.message}`);
        // strict: storage failed (not "no record"); the caller must
        // not carry on as if the session had no owner or members
        if (strict) {
            throw error;
        }
        return null;
    }
}


export function writeRecord(sessionKey, record) {

    return queued(recordKey(sessionKey), () =>
        writeJson(recordKey(sessionKey), { ...record, updatedAt: new Date().toISOString() })
    );
}


/*
 * The record for a room's current state. `known` keeps
 * approved people who are offline right now: leaving
 * for a moment does not cost anyone their place.
 */
export function recordOf(room) {

    const members = {};

    for (const [userId, member] of room.known) {
        members[userId] = { name: member.name, role: member.role };
    }

    return {
        sessionKey: room.sessionKey,
        sceneId: room.sceneId,
        owner: room.owner ? { userId: room.owner.userId, name: room.owner.name } : null,
        sessionName: room.sessionName,
        sessionType: room.sessionType,
        members,
        removed: [...room.banned].sort(),
        closedByAdmin: room.closedByAdmin || null,
        createdAt: room.recordCreatedAt
    };
}
