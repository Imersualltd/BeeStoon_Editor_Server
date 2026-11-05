/*
 * Editor access test (EDITOR_ACCESS=beestoon)
 * --------------------------------------------------
 * A fake BeeStoon API answers /internal/editor/access
 * from a set of account ids it can change mid-test.
 * Ada and Bob have editor access, Cid does not (his
 * login token is valid and his email is verified).
 *
 *   - joining, also with an email invite, needs access
 *   - /sessions/mine needs access
 *   - removing Bob's access while he is connected:
 *     his browser leaves (4106), his download ticket
 *     stops working, his role is kept; ticking it again
 *     lets him back with the same role
 *   - the API not answering: no new joins, and after
 *     two failed rechecks everyone connected leaves
 *
 *   node test/editor-access.test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import { Client } from '@colyseus/sdk';


const PORT = 3600 + Math.floor(Math.random() * 300);
const SERVER = `http://localhost:${PORT}`;
const SECRET = 'editor-secret-for-tests-only-0123456789';
const SERVICE_KEY = 'service-key-for-tests-only-0123456789abc';
const SITE = 'https://site.test';
const KEY = 'access-session-01';

const ID = {
    ada: '11111111-1111-4111-8111-111111111111',
    bob: '22222222-2222-4222-8222-222222222222',
    cid: '33333333-3333-4333-8333-333333333333'
};


let passed = 0;

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function waitFor(fn, label, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await fn()) {
            return;
        }
        await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
}


// ==================================================
// FAKE BEESTOON API (access only)
// ==================================================

const api = { access: new Set([`jwt:${ID.ada}`, `jwt:${ID.bob}`]), down: false, calls: 0 };

const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        if (req.headers['x-editor-service-key'] !== SERVICE_KEY) {
            return send(403, {});
        }
        if (req.method !== 'POST' || req.url !== '/internal/editor/access') {
            return send(404, {});
        }
        api.calls++;
        if (api.down) {
            return send(503, { detail: 'down' });
        }
        const ids = JSON.parse(body || '{}').userIds || [];
        return send(200, { access: Object.fromEntries(ids.map((id) => [id, api.access.has(id)])) });
    });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const API = `http://127.0.0.1:${fake.address().port}`;


// ==================================================
// SERVER
// ==================================================

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-access-test-'));

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'jwt',
        JWT_SECRET: SECRET,
        JWT_ISSUER: 'beestoon-api',
        JWT_AUDIENCE: 'beestoon-editor',
        CORS_ORIGINS: SITE,
        CREDITS_ENABLED: 'false',
        EDITOR_ACCESS: 'beestoon',
        EDITOR_ACCESS_RECHECK_SECONDS: '1',
        BEESTOON_API_URL: API,
        EDITOR_SERVICE_KEY: SERVICE_KEY,
        MAIL_PROVIDER: 'capture',
        MAIL_CAPTURE_DIR: path.join(storageDir, 'mail'),
        INVITE_BASE_URL: `${SITE}/editor`,
        AR_STORAGE: 'local',
        AR_LOCAL_DIR: path.join(storageDir, 'ar'),
        SCENE_STORAGE: 'local',
        SCENE_LOCAL_DIR: path.join(storageDir, 'scenes')
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));


function token(name) {
    return jwt.sign(
        { sub: ID[name], name, email: `${name}@test.org`, email_verified: true },
        SECRET,
        { algorithm: 'HS256', issuer: 'beestoon-api', audience: 'beestoon-editor', expiresIn: '15m' }
    );
}


async function connect(name, mode = 'join', extra = {}) {
    const client = new Client(SERVER);
    client.auth.token = token(name);
    const room = await client[mode]('session', { sessionKey: KEY, ...extra });
    const user = { room, messages: [], state: null, leftCode: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    room.onLeave((code) => { user.leftCode = code; });
    user.got = (type, pred = () => true) => user.messages.some((m) => m.type === type && pred(m.payload));
    user.send = (type, data = {}) => room.send(type, data);
    await waitFor(() => user.state, 'session:state');
    return user;
}

const refusal = (name) => connect(name).then((u) => { u.room.leave(); return null; }, (e) => e);


async function download(ticket, sceneId) {
    const res = await fetch(`${SERVER}/assets/${sceneId}/missing.glb`, {
        headers: ticket ? { Authorization: `Bearer ${ticket}` } : {}
    });
    return res.status;
}


async function mine(name) {
    const res = await fetch(`${SERVER}/sessions/mine`, { headers: { Authorization: `Bearer ${token(name)}` } });
    return res.status;
}


async function members(userId) {
    const res = await fetch(`${SERVER}/internal/sessions/${KEY}/members/${encodeURIComponent(userId)}`, {
        headers: { 'X-Editor-Service-Key': SERVICE_KEY }
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}


async function main() {

    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);

    check('the server says how access is checked', () => {
        assert.match(serverLog, /Editor access: BeeStoon account tick, rechecked every 1s/);
    });


    console.log('\nJoining');

    const ada = await connect('ada', 'create', { sessionType: 'basic', sessionName: 'Access' });
    check('an account with editor access creates a session', () => assert.equal(ada.state.you.status, 'approved'));

    const cidAlone = await refusal('cid');
    check('an account without editor access cannot join (403)', () => assert.equal(cidAlone?.code, 403));

    ada.send('invite:email', { emails: ['bob@test.org', 'cid@test.org'], role: 'editor' });
    await waitFor(() => ada.got('invite:result'), 'invite result');

    const cidInvited = await refusal('cid');
    check('an email invite does not let an account without access in', () => assert.equal(cidInvited?.code, 403));

    const bob = await connect('bob');
    check('an invited account with access is let in with the invited role', () => {
        assert.equal(bob.state.you.status, 'approved');
        assert.equal(bob.state.you.role, 'editor');
    });
    await waitFor(() => bob.state.you.ticket, 'bob ticket');
    const sceneId = bob.state.sceneId;
    const bobTicket = bob.state.you.ticket;

    const before = await download(bobTicket, sceneId);
    check('session assets: Bob\'s ticket passes the download check (file lookup, not 401)', () => assert.notEqual(before, 401));

    const mineBob = await mine('bob');
    const mineCid = await mine('cid');
    check('/sessions/mine needs editor access', () => {
        assert.equal(mineBob, 200);
        assert.equal(mineCid, 403);
    });


    console.log('\nRemoving access while connected');

    api.access.delete(`jwt:${ID.bob}`);
    await waitFor(() => bob.leftCode !== null, 'bob removed');
    check('Bob\'s browser leaves with code 4106 within the recheck interval', () => assert.equal(bob.leftCode, 4106));

    const after = await download(bobTicket, sceneId);
    check('Bob\'s download ticket stops working', () => assert.equal(after, 401));

    const bobMember = await members(`jwt:${ID.bob}`);
    check('Bob\'s role is kept with the session (access is not a role)', () => {
        assert.equal(bobMember.json?.role, 'editor');
    });

    const bobBack = await refusal('bob');
    check('Bob cannot join again while access is off', () => assert.equal(bobBack?.code, 403));
    check('Ada (still with access) stays connected', () => assert.equal(ada.leftCode, null));

    api.access.add(`jwt:${ID.bob}`);
    const bob2 = await connect('bob');
    await waitFor(() => bob2.state.you.ticket, 'new ticket');
    const regained = await download(bob2.state.you.ticket, sceneId);
    check('ticking access again lets Bob back with his role and a new working ticket', () => {
        assert.equal(bob2.state.you.role, 'editor');
        assert.notEqual(bob2.state.you.ticket, bobTicket);
        assert.notEqual(regained, 401);
    });


    console.log('\nBeeStoon API not answering');

    api.down = true;
    const whileDown = await refusal('bob');
    check('no new join while access cannot be confirmed (503)', () => assert.equal(whileDown?.code, 503));
    await waitFor(() => ada.leftCode !== null && bob2.leftCode !== null, 'everyone out', 8000);
    check('after two failed rechecks everyone connected leaves (4106)', () => {
        assert.equal(ada.leftCode, 4106);
        assert.equal(bob2.leftCode, 4106);
    });
    api.down = false;

    console.log(`\nAll ${passed} editor access checks passed`);
}


try {
    await main();
} catch (error) {
    console.error(error);
    console.error('--- server log ---\n' + serverLog.slice(-4000));
    process.exitCode = 1;
} finally {
    server.kill();
    fake.close();
    await rm(storageDir, { recursive: true, force: true });
}
