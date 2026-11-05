/*
 * BeeStoon editor access
 * --------------------------------------------------
 * EDITOR_ACCESS=beestoon (required in production):
 *   every person needs the "Editor access" tick on
 *   their BeeStoon account. The BeeStoon API decides
 *   (POST /internal/editor/access, EDITOR_SERVICE_KEY);
 *   this server never keeps a list of its own.
 *
 *   - joining a room (also through an invite link) and
 *     the HTTP routes that log in with the editor token
 *     ask first; no answer = no access
 *   - connected people are asked again every
 *     EDITOR_ACCESS_RECHECK_SECONDS (default 30). When
 *     the tick is removed, all their browsers leave
 *     (code 4106) and their download tickets stop
 *     working. Their role in the session is kept, so
 *     ticking it again lets them back in.
 *   - when the API cannot be asked twice in a row, every
 *     connected person leaves too (access unknown = no
 *     access)
 *
 *   - matchmaking asks too (ModelRoom.onAuth, static):
 *     no room is created and no seat reserved for an
 *     anonymous or unticked account, also when someone
 *     calls /matchmake directly
 *
 * EDITOR_ACCESS=open (default, development): no check.
 *
 * Access is not a role and not a payment: roles still
 * come from the session, credits from the ledger.
 */

export const ACCESS_REMOVED_CODE = 4106;
export const ACCESS_MESSAGE = 'Editor access is by invitation. Ask the BeeStoon team to enable it for your account.';


export function accessMode(env = process.env) {

    return String(env.EDITOR_ACCESS || 'open').toLowerCase();
}


export function accessChecked(env = process.env) {

    return accessMode(env) === 'beestoon';
}


/*
 * With EDITOR_ACCESS=beestoon the login must be the
 * BeeStoon token, whatever else is set (also with
 * EDITOR_DEPLOYMENT=development): a dashboard or
 * blueprint change that brings the dev login back makes
 * the server refuse to start instead of letting anyone in.
 */
export function accessProblems(env = process.env) {

    if (!accessChecked(env)) {
        return [];
    }

    const problems = [];

    if ((env.AUTH_PROVIDER || 'dev').toLowerCase() !== 'jwt') {
        problems.push('EDITOR_ACCESS=beestoon needs AUTH_PROVIDER=jwt');
    }

    if (env.ALLOW_DEV_AUTH === 'true') {
        problems.push('EDITOR_ACCESS=beestoon cannot run with ALLOW_DEV_AUTH=true');
    }

    if (!env.BEESTOON_API_URL || String(env.EDITOR_SERVICE_KEY || '').length < 32) {
        problems.push('EDITOR_ACCESS=beestoon needs BEESTOON_API_URL and EDITOR_SERVICE_KEY (32+ characters)');
    }

    return problems;
}


export class AccessError extends Error {

    constructor(status, message) {
        super(message);
        this.status = status;
    }
}


/*
 * userIds -> Map(userId -> true|false). Throws
 * AccessError(503) when the API cannot answer.
 */
export async function lookupAccess(userIds) {

    const ids = [...new Set(userIds)];

    if (!ids.length) {
        return new Map();
    }

    const base = String(process.env.BEESTOON_API_URL || '').replace(/\/+$/, '');
    const key = process.env.EDITOR_SERVICE_KEY || '';
    const unavailable = new AccessError(503, 'BeeStoon could not confirm your editor access. Try again in a moment.');

    if (!base || key.length < 32) {
        throw unavailable;
    }

    let response;

    try {
        response = await fetch(`${base}/internal/editor/access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Editor-Service-Key': key },
            body: JSON.stringify({ userIds: ids }),
            signal: AbortSignal.timeout(5000)
        });
    } catch {
        throw unavailable;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || typeof data.access !== 'object' || data.access === null) {
        console.error(`BeeStoon editor access answered ${response.status}`);
        throw unavailable;
    }

    // Anything but an explicit true is "no"
    return new Map(ids.map((id) => [id, data.access[id] === true]));
}


// Replaced in tests
let lookup = lookupAccess;

export function setAccessLookup(fn) {

    lookup = fn || lookupAccess;
}


export async function requireAccess(userId) {

    if (!accessChecked()) {
        return;
    }

    const answer = await lookup([userId]);

    if (answer.get(userId) !== true) {
        throw new AccessError(403, ACCESS_MESSAGE);
    }
}


export function recheckSeconds(env = process.env) {

    const value = Number(env.EDITOR_ACCESS_RECHECK_SECONDS);

    return Number.isFinite(value) && value >= 1 && value <= 300 ? value : 30;
}


/*
 * One recheck of everyone connected. rooms: iterable of
 * live rooms (each with users: Map(userId -> user) and
 * removeForAccess(userId, reason)). Returns what was done.
 */
let failures = 0;

export async function recheckConnected(rooms) {

    if (!accessChecked()) {
        return { checked: 0, removed: [] };
    }

    const live = [...rooms];
    const ids = new Set();

    for (const room of live) {
        for (const userId of room.users.keys()) {
            ids.add(userId);
        }
    }

    if (!ids.size) {
        failures = 0;
        return { checked: 0, removed: [] };
    }

    let answer;

    try {
        answer = await lookup([...ids]);
        failures = 0;
    } catch (error) {
        failures++;
        console.error(`Editor access recheck failed (${failures} in a row): ${error.message}`);

        if (failures < 2) {
            return { checked: 0, removed: [], failed: true };
        }

        answer = new Map([...ids].map((id) => [id, false]));
    }

    const removed = [];

    for (const room of live) {
        for (const userId of [...room.users.keys()]) {
            if (answer.get(userId) !== true) {
                room.removeForAccess(userId, failures >= 2
                    ? 'BeeStoon could not confirm your editor access. Reopen the editor in a moment.'
                    : 'Editor access was removed from your account.');
                removed.push(userId);
            }
        }
    }

    return { checked: ids.size, removed };
}


export function resetRecheckFailures() {

    failures = 0;
}


export function startAccessRecheck(getRooms) {

    if (!accessChecked()) {
        return null;
    }

    const timer = setInterval(() => {
        recheckConnected(getRooms()).catch((error) => console.error('Editor access recheck:', error));
    }, recheckSeconds() * 1000);

    timer.unref?.();

    console.log(`Editor access: BeeStoon account tick, rechecked every ${recheckSeconds()}s`);

    return timer;
}
