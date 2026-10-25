/*
 * Session registry + HTTP tickets
 * --------------------------------------------------
 * Every share link has its own room (one sessionKey
 * = one ModelRoom). This module keeps:
 *
 *   - the live rooms by sessionKey, so nobody can
 *     create a second room with a key already in use
 *   - "tickets": a random secret the room gives each
 *     approved user. The HTTP routes (/convert,
 *     /export/fbx) are not part of the room, so the
 *     client sends the ticket in the header
 *       Authorization: Bearer <ticket>
 *     and the route asks the room for that user's
 *     CURRENT role. Demoting someone takes effect on
 *     their next request.
 *
 * Everything is in memory (one server process).
 */

import { randomBytes } from 'node:crypto';


export const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;


// sessionKey -> room
const rooms = new Map();

// ticket -> { room, userId }
const tickets = new Map();


export function registerSession(sessionKey, room) {

    if (rooms.has(sessionKey)) {
        throw new Error('This session already exists');
    }

    rooms.set(sessionKey, room);
}


export function unregisterSession(sessionKey, room) {

    if (rooms.get(sessionKey) === room) {
        rooms.delete(sessionKey);
    }

    for (const [ticket, entry] of tickets) {
        if (entry.room === room) {
            tickets.delete(ticket);
        }
    }
}


export function issueTicket(room, userId) {

    const ticket = randomBytes(24).toString('base64url');

    tickets.set(ticket, { room, userId });

    return ticket;
}


export function revokeTickets(room, userId) {

    for (const [ticket, entry] of tickets) {
        if (entry.room === room && entry.userId === userId) {
            tickets.delete(ticket);
        }
    }
}


/*
 * Express middleware: only admins and editors of a
 * live session may use the route.
 */
export function requireEditor(req, res, next) {

    const header = String(req.headers.authorization || '');

    const ticket = header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : '';

    const entry = ticket ? tickets.get(ticket) : null;

    if (!entry) {
        res.status(401).send('Join a session first (missing or expired ticket)');
        return;
    }

    const role = entry.room.roleOf(entry.userId);

    if (role !== 'admin' && role !== 'editor') {
        res.status(403).send('Only admins and editors can do this');
        return;
    }

    next();
}
