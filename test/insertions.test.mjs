/*
 * BeeStoon models added to a session (insertions.mjs)
 * --------------------------------------------------
 * A fake BeeStoon API answers access, reserve and
 * confirm, and serves the owner's model file. Ada (admin)
 * adds her model to room A; Bob (editor) sees and edits
 * the session copy; Vic (viewer) cannot add; nobody
 * without a ticket gets the file. The object is saved
 * before the insertion is confirmed, a retry never adds
 * it twice, the wrong room is refused, and after a
 * restart the reopened scene still has it, edit included.
 *
 *   node test/insertions.test.mjs
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


const PORT = 3900 + Math.floor(Math.random() * 300);
const SERVER = `http://localhost:${PORT}`;
const SECRET = 'editor-secret-for-tests-only-0123456789';
const SERVICE_KEY = 'service-key-for-tests-only-0123456789abc';
const SITE = 'https://site.test';
const ROOM_A = 'insert-room-a01';
const ROOM_B = 'insert-room-b01';
const ID = {
    ada: '11111111-1111-4111-8111-111111111111',
    bob: '22222222-2222-4222-8222-222222222222',
    vic: '33333333-3333-4333-8333-333333333333',
    eve: '44444444-4444-4444-8444-444444444444'
};
const INSERT_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const MODEL = 'bbbbbbbb-0000-4000-8000-000000000001';

let passed = 0;

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function waitFor(fn, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await fn()) {
            return;
        }
        await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
}


// A small real-looking GLB (magic + version 2)
const glb = Buffer.alloc(256, 7);
glb.writeUInt32LE(0x46546C67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(256, 8);


// ==================================================
// FAKE BEESTOON API
// ==================================================

const api = {
    insertions: new Map([[INSERT_1, { sessionKey: ROOM_A, owner: `jwt:${ID.ada}`, status: 'pending', objectId: null }]]),
    reserves: [], confirms: [], fileGets: 0
};

const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        if (req.url === '/files/model.glb') {
            api.fileGets++;
            res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': glb.length });
            return res.end(glb);
        }
        if (req.headers['x-editor-service-key'] !== SERVICE_KEY) {
            return send(403, {});
        }
        const data = body ? JSON.parse(body) : {};
        if (req.url === '/internal/editor/access') {
            return send(200, { access: Object.fromEntries((data.userIds || []).map((id) => [id, true])) });
        }
        const match = req.url.match(/^\/internal\/editor\/insertions\/([^/]+)\/(reserve|confirm)$/);
        const row = match && api.insertions.get(match[1]);
        if (!row) {
            return send(404, { detail: { code: 'not_found', message: 'Nothing to add.' } });
        }
        if (row.sessionKey !== data.sessionKey) {
            return send(409, { detail: { code: 'wrong_session', message: 'This model is for another session.' } });
        }
        if (match[2] === 'reserve') {
            api.reserves.push(data);
            if (row.owner !== data.userId) {
                return send(404, { detail: { code: 'not_found', message: 'Nothing to add.' } });
            }
            if (row.status === 'confirmed') {
                return send(409, { detail: { code: 'already_added', message: 'This model is already in the session.' } });
            }
            return send(200, { fileUrl: `http://127.0.0.1:${fake.address().port}/files/model.glb`, name: 'beestoon-abc.glb',
                variant: 'finalized', modelId: MODEL });
        }
        api.confirms.push(data);
        if (row.status === 'confirmed' && row.objectId !== data.objectId) {
            return send(409, { detail: { code: 'already_added' } });
        }
        row.status = 'confirmed';
        row.objectId = data.objectId;
        return send(200, { confirmed: true });
    });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const API = `http://127.0.0.1:${fake.address().port}`;


// ==================================================
// SERVER
// ==================================================

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-insert-test-'));
const env = {
    ...process.env,
    PORT: String(PORT),
    AUTH_PROVIDER: 'jwt', JWT_SECRET: SECRET, JWT_ISSUER: 'beestoon-api', JWT_AUDIENCE: 'beestoon-editor',
    CORS_ORIGINS: SITE, CREDITS_ENABLED: 'false', EDITOR_ACCESS: 'beestoon',
    BEESTOON_API_URL: API, EDITOR_SERVICE_KEY: SERVICE_KEY, MAIL_PROVIDER: 'log',
    INVITE_BASE_URL: `${SITE}/editor`, PUBLIC_BASE_URL: SERVER,
    SCENE_STORAGE: 'local', SCENE_LOCAL_DIR: path.join(storageDir, 'scenes'), AUTOSAVE_MINUTES: '0'
};

let serverLog = '';
let server;

function start() {
    serverLog = '';
    server = spawn(process.execPath, ['src/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    return waitFor(() => serverLog.includes('listening'), 'server start', 15000);
}

function token(name) {
    return jwt.sign({ sub: ID[name], name, email: `${name}@test.org`, email_verified: true }, SECRET,
        { algorithm: 'HS256', issuer: 'beestoon-api', audience: 'beestoon-editor', expiresIn: '15m' });
}

async function connect(name, key, mode = 'joinOrCreate') {
    const client = new Client(SERVER);
    client.auth.token = token(name);
    const room = await client[mode]('session', { sessionKey: key, sessionType: 'basic', sessionName: 'Insert' });
    const user = { room, messages: [], state: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.got = (type, pred = () => true) => user.messages.find((m) => m.type === type && pred(m.payload))?.payload;
    user.send = (type, data = {}) => room.send(type, data);
    await waitFor(() => user.state, 'session:state');
    return user;
}

async function download(url, ticket) {
    const res = await fetch(url, { headers: ticket ? { Authorization: `Bearer ${ticket}` } : {} });
    return { status: res.status, body: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}


async function main() {

    await start();

    console.log('\nAdding');

    const ada = await connect('ada', ROOM_A);
    ada.send('invite:email', { emails: ['bob@test.org', 'vic@test.org'], role: 'editor' });
    await waitFor(() => ada.got('invite:result'), 'invites');
    const bob = await connect('bob', ROOM_A);
    await waitFor(() => bob.state.you.status === 'approved', 'bob approved');

    ada.send('beestoon:insert', { insertionId: INSERT_1 });
    const done = await waitFor(() => ada.got('beestoon:inserted'), 'inserted').then(() => ada.got('beestoon:inserted'));
    const added = await waitFor(() => bob.got('object:add', (o) => o.insertionId === INSERT_1), 'bob gets it')
        .then(() => bob.got('object:add', (o) => o.insertionId === INSERT_1));
    check('the owner\'s model is added for everyone, the owner too, as a session copy', () => {
        assert.ok(ada.got('object:add', (o) => o.insertionId === INSERT_1));
        assert.equal(added.name, 'beestoon-abc.glb');
        assert.match(added.url, new RegExp(`^${SERVER}/assets/[A-Za-z0-9_-]+/[0-9a-f]{64}\\.glb$`));
        assert.equal(added.transform, null);   // the file's own scale
        assert.deepEqual(added.source, { kind: 'beestoon', modelId: MODEL, variant: 'finalized' });
    });
    check('reserved for this session and its owner, saved, then confirmed once', () => {
        assert.deepEqual(api.reserves[0], { sessionKey: ROOM_A, userId: `jwt:${ID.ada}` });
        assert.equal(api.confirms.length, 1);
        assert.deepEqual(api.confirms[0], { sessionKey: ROOM_A, objectId: done.objectId });
        assert.equal(done.confirmed, true);
        assert.match(serverLog, /saved "Added beestoon-abc\.glb"/);
    });

    ada.send('beestoon:insert', { insertionId: INSERT_1 });
    await waitFor(() => ada.messages.filter((m) => m.type === 'beestoon:inserted').length === 2, 'retry answer');
    check('a retry adds nothing: "already added", no second copy or confirmation', () => {
        assert.equal(ada.messages.filter((m) => m.type === 'beestoon:inserted')[1].payload.already, true);
        assert.equal(bob.messages.filter((m) => m.type === 'object:add').length, 1);
        assert.equal(api.confirms.length, 1);
        assert.equal(api.fileGets, 1);
    });


    console.log('\nWho can add, who can fetch');

    const other = 'aaaaaaaa-0000-4000-8000-000000000002';
    api.insertions.set(other, { sessionKey: ROOM_A, owner: `jwt:${ID.ada}`, status: 'pending', objectId: null });
    const adaB = await connect('ada', ROOM_B);
    adaB.send('beestoon:insert', { insertionId: other });
    await waitFor(() => adaB.got('beestoon:insert-failed'), 'wrong room');
    check('in another room the insertion is refused by the API (bound to its session) and nothing is added', () => {
        assert.equal(adaB.got('beestoon:insert-failed').code, 'wrong_session');
        assert.equal(adaB.messages.filter((m) => m.type === 'object:add').length, 0);
        assert.equal(api.insertions.get(other).status, 'pending');   // still there for room A
    });
    adaB.room.leave();

    bob.send('beestoon:insert', { insertionId: other });
    await waitFor(() => bob.got('beestoon:insert-failed'), 'not the owner');
    check('another member cannot add the owner\'s model', () => assert.equal(bob.got('beestoon:insert-failed').code, 'not_found'));

    ada.send('role:set', { userId: `jwt:${ID.bob}`, role: 'viewer' });
    await waitFor(() => bob.state.you.role === 'viewer', 'bob viewer');
    bob.send('beestoon:insert', { insertionId: other });
    await waitFor(() => bob.messages.filter((m) => m.type === 'beestoon:insert-failed').length === 2, 'viewer refused');
    check('a read-only guest (viewer) cannot add models', () =>
        assert.equal(bob.messages.filter((m) => m.type === 'beestoon:insert-failed')[1].payload.code, 'role'));
    ada.send('role:set', { userId: `jwt:${ID.bob}`, role: 'editor' });
    await waitFor(() => bob.state.you.role === 'editor', 'bob editor again');

    const asBob = await download(added.url, bob.state.you.ticket);
    const anonymous = await download(added.url, null);
    const eve = await connect('eve', 'insert-room-eve1');
    const asEve = await download(added.url, eve.state.you.ticket);
    check('members download the session copy with their ticket; nobody else can', () => {
        assert.equal(asBob.status, 200);
        assert.ok(asBob.body.equals(glb));
        assert.equal(anonymous.status, 401);
        assert.equal(asEve.status, 401);   // a ticket of another session
    });
    eve.room.leave();


    console.log('\nShared editing');

    bob.send('object:material', { id: done.objectId, index: 0, patch: { color: '#ff0000' } });
    await waitFor(() => ada.got('object:materials', (m) => m.id === done.objectId), 'ada sees the edit');
    check('another member edits the copy and the owner sees it', () =>
        assert.deepEqual(ada.got('object:materials', (m) => m.id === done.objectId).materials, { 0: { color: '#ff0000' } }));
    ada.send('scene:save', { name: 'With red' });
    await waitFor(() => serverLog.includes('saved "With red"'), 'saved');


    console.log('\nReopening after a restart');

    ada.room.leave();
    bob.room.leave();
    await sleep(300);
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    await start();
    const ada2 = await connect('ada', ROOM_A);
    ada2.send('sync-request', { have: [] });
    const restored = await waitFor(() => ada2.got('object:add', (o) => o.insertionId === INSERT_1), 'restored')
        .then(() => ada2.got('object:add', (o) => o.insertionId === INSERT_1));
    check('the reopened scene has the shared copy with the edit', () => {
        assert.equal(restored.id, done.objectId);
        assert.equal(restored.materials?.['0']?.color ?? restored.materials?.[0]?.color, '#ff0000');
    });
    ada2.send('beestoon:insert', { insertionId: INSERT_1 });
    await waitFor(() => ada2.got('beestoon:inserted'), 'retry after reopen');
    check('a retry after reopening still adds nothing', () => {
        assert.equal(ada2.got('beestoon:inserted').already, true);
        assert.equal(api.fileGets, 1);
    });
    ada2.room.leave();

    console.log(`\nAll ${passed} insertion checks passed`);
}


try {
    await main();
} catch (error) {
    console.error(error);
    console.error('--- server log ---\n' + serverLog.slice(-4000));
    process.exitCode = 1;
} finally {
    server?.kill();
    fake.close();
    await rm(storageDir, { recursive: true, force: true });
}
