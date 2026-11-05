/*
 * Internal routes for the BeeStoon backend
 * --------------------------------------------------
 * Server to server only: every request carries
 *   X-Editor-Service-Key: <EDITOR_SERVICE_KEY>
 * (a key only this server and the BeeStoon backend
 * know, 32+ characters). Without the key configured
 * the routes answer 404, as if they did not exist.
 *
 * GET /internal/sessions/<sessionKey>/members/<userId>
 *   Is this person in the session, and with which role?
 *     live session   an APPROVED person in the room
 *                    (pending, denied and kicked people
 *                    are not members)
 *     saved session  the owner, or someone saved as an
 *                    attendee (kicked people are taken
 *                    out of the attendees on save)
 *   -> { member: true, role, owner, live }
 *   -> 404 { member: false }   (unknown session or not in it)
 *
 * The BeeStoon backend asks this before it shows a
 * session's image library or links a generation to a
 * session. A session key alone is never enough.
 *
 * POST /internal/sessions/<sessionKey>/pool/spend
 *   { userId, amount, key }
 *   The backend asks whether the session pool pays one
 *   BeeStoon purchase (a model import) for this member.
 *   Only a live session, only when the admin let the pool
 *   pay for models, only with enough left. The same key
 *   never spends twice.
 *   -> { paid: true, left }  |  { paid: false, reason }
 * POST /internal/sessions/<sessionKey>/pool/refund { key }
 *   The purchase did not go through: the pool gets the
 *   credits of that key back (once).
 */

import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import { sceneOfKey } from './scene-versions.mjs';
import { liveRoomOf, SESSION_KEY_PATTERN } from './sessions.mjs';
import { USER_ID_PATTERN } from './auth/util.mjs';


function serviceKeyOk(req) {

    const expected = Buffer.from(process.env.EDITOR_SERVICE_KEY || '');
    const given = Buffer.from(String(req.headers['x-editor-service-key'] || ''));

    return expected.length >= 32 && given.length === expected.length && timingSafeEqual(given, expected);
}


export async function membershipOf(sessionKey, userId) {

    const room = liveRoomOf(sessionKey);

    if (room && !room.closed) {

        if (room.banned?.has(userId)) {
            return null;
        }

        const user = room.users?.get(userId);

        if (user?.status === 'approved' && user.role) {
            return { member: true, role: user.role, owner: room.owner?.userId === userId, live: true };
        }

        // Not (yet) let in: the saved attendee list does not
        // count while the room is open, the room decides
        return null;
    }

    const scene = await sceneOfKey(sessionKey);

    if (!scene) {
        return null;
    }

    if (scene.owner?.userId === userId) {
        return { member: true, role: 'admin', owner: true, live: false };
    }

    const role = scene.attendees?.[userId]?.role;

    if (role && !(scene.removed || []).includes(userId)) {
        return { member: true, role, owner: false, live: false };
    }

    return null;
}


const SPEND_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,120}$/;


export function registerInternalRoutes(app) {

    app.post('/internal/sessions/:sessionKey/pool/:action', express.json({ limit: '4kb' }), async (req, res) => {

        res.setHeader('Cache-Control', 'no-store');

        if (!serviceKeyOk(req)) {
            res.status(404).end();
            return;
        }

        const { sessionKey, action } = req.params;
        const { userId, amount, key } = req.body || {};

        if (!SESSION_KEY_PATTERN.test(sessionKey) || !SPEND_KEY_PATTERN.test(String(key || '')) ||
            !['spend', 'refund'].includes(action)) {
            res.status(400).json({ error: 'Not a valid pool request' });
            return;
        }

        const room = liveRoomOf(sessionKey);

        if (action === 'refund') {
            res.json({ refunded: !!room && room.refundPool(key) });
            return;
        }

        if (!Number.isInteger(amount) || amount < 1 || amount > 10000 || !USER_ID_PATTERN.test(String(userId || ''))) {
            res.status(400).json({ error: 'Not a valid pool request' });
            return;
        }

        if (!room || room.closed) {
            res.json({ paid: false, reason: 'not_live' });
            return;
        }

        if (!(await membershipOf(sessionKey, userId))) {
            res.status(403).json({ paid: false, reason: 'not_member' });
            return;
        }

        const result = room.spendPool(amount, key);

        console.log(`[pool] ${sessionKey} ${key}: ${result.paid ? `paid ${amount}` : result.reason}`);

        res.json(result);
    });


    app.get('/internal/sessions/:sessionKey/members/:userId', async (req, res) => {

        res.setHeader('Cache-Control', 'no-store');

        if (!serviceKeyOk(req)) {
            res.status(404).end();
            return;
        }

        const { sessionKey, userId } = req.params;

        if (!SESSION_KEY_PATTERN.test(sessionKey) || !USER_ID_PATTERN.test(userId)) {
            res.status(404).json({ member: false });
            return;
        }

        try {

            const found = await membershipOf(sessionKey, userId);

            if (!found) {
                res.status(404).json({ member: false });
                return;
            }

            res.json(found);

        } catch (error) {

            console.error(`Membership check failed: ${error.message}`);

            res.status(500).json({ error: 'Could not check the session' });
        }
    });
}
