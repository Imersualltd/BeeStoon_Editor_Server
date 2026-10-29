/*
 * Admin rules test
 * --------------------------------------------------
 * - an admin moving an object an editor holds keeps
 *   the editor's lock (the editor waits meanwhile)
 * - people doing nothing for IDLE_MINUTES are taken
 *   out, after a warning; the last admin going that way
 *   hands admin to the oldest editor
 *
 *   node test/admin-rules.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3500 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;


// ==================================================
// HELPERS
// ==================================================

let passed = 0;

function check(label, fn) {

    fn();
    passed++;
    console.log(`  ok  ${label}`);
}


async function waitFor(fn, label, timeout = 3000) {

    const end = Date.now() + timeout;

    while (Date.now() < end) {

        if (fn()) {
            return;
        }

        await sleep(25);
    }

    throw new Error(`Timed out: ${label}`);
}


async function connect(name, sessionKey, mode = 'join', extra = {}) {

    const client = new Client(URL);

    const room = await client[mode]('session', {
        sessionKey,
        identity: { userId: name.toLowerCase(), name },
        ...extra
    });

    const user = { name, room, messages: [], state: null, leftCode: null };

    room.onLeave((code) => {
        user.leftCode = code;
    });

    room.onMessage('*', (type, payload) => {

        user.messages.push({ type, payload });

        if (type === 'session:state') {
            user.state = payload;
        }
    });

    user.got = (type, pred = () => true) =>
        user.messages.some((m) => m.type === type && pred(m.payload));

    user.send = (type, data = {}) => room.send(type, data);

    await waitFor(() => user.state, `${name} gets session:state`);

    return user;
}


// Smallest file the server accepts as a GLB: the
// 12-byte header, then filler. `seed` makes it unique.
function fakeGlb(size, seed = 0) {

    const body = Buffer.alloc(size, seed & 0xff);

    body.writeUInt32LE(0x46546C67, 0);
    body.writeUInt32LE(2, 4);
    body.writeUInt32LE(size, 8);
    body.writeUInt32LE(seed, 12);

    return body;
}


async function upload(ticket, body, name = 'model.glb') {

    const headers = { 'Content-Type': 'application/octet-stream' };

    if (ticket) {
        headers.Authorization = `Bearer ${ticket}`;
    }

    const res = await fetch(`${URL}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers,
        body
    });

    const text = await res.text();

    let json = null;

    try {
        json = JSON.parse(text);
    } catch {
        // error replies are plain text
    }

    return { status: res.status, json, text };
}


const POSE = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };


const pose = (x) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

const objectIn = (user, id) => user.state.objects?.find((o) => o.id === id);

const last = (user, type, pred = () => true) =>
    [...user.messages].reverse().find((m) => m.type === type && pred(m.payload))?.payload;

async function approve(admin, user, role) {

    admin.send('join:approve', { userId: `dev:${user.name.toLowerCase()}`, role });

    await waitFor(() => user.state.you.status === 'approved', `${user.name} approved`);
}


// ==================================================
// SERVER
// ==================================================

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-admin-test-'));

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'dev',
        ALLOW_DEV_AUTH: 'true',
        MAIL_PROVIDER: 'log',
        AR_STORAGE: 'local',
        AR_LOCAL_DIR: path.join(storageDir, 'ar'),
        SCENE_STORAGE: 'local',
        SCENE_LOCAL_DIR: path.join(storageDir, 'scenes'),
        // 6 seconds idle, warned 3 seconds before
        IDLE_MINUTES: '0.1',
        IDLE_WARNING_MINUTES: '0.05'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';

server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));


// Let the server finish its last saves before the
// temp folder is removed
function stopServer() {

    if (server.exitCode !== null) {
        return Promise.resolve();
    }

    const exited = new Promise((resolve) => server.once('exit', resolve));

    server.kill();

    return Promise.race([exited, sleep(5000)]);
}


async function main() {

    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);


    console.log('\nNobody else can remove the owner');

    const own = await connect('Olga', 'owner-session-0001', 'create');
    const pat = await connect('Pat', 'owner-session-0001');
    await approve(own, pat, 'admin');

    pat.send('user:kick', { userId: 'dev:olga' });
    await waitFor(() => pat.got('action:denied', (d) => d.type === 'user:kick'), 'kick refused');
    check('another admin cannot remove the owner', () => {
        assert.match(last(pat, 'action:denied', (d) => d.type === 'user:kick').reason, /owner/);
        assert.equal(own.leftCode, null);
    });

    pat.send('role:set', { userId: 'dev:olga', role: 'viewer' });
    await waitFor(() => pat.got('action:denied', (d) => d.type === 'role:set'), 'role change refused');
    check('... or change the owner\'s role', () => {
        assert.equal(own.state.you.role, 'admin');
    });

    own.room.leave();
    pat.room.leave();


    console.log('\nAdmin takes over an object an editor holds');

    const KEY = 'admin-rules-0001';

    const ada = await connect('Ada', KEY, 'create');
    const bob = await connect('Bob', KEY);
    const eve = await connect('Eve', KEY);

    await approve(ada, bob, 'editor');
    await approve(ada, eve, 'editor');

    // Keep everyone active while this part runs
    const keepAlive = setInterval(() => [ada, bob, eve].forEach((u) => u.send('activity')), 1000);

    ada.send('object:add', { id: 'sofa', name: 'sofa.glb', dataUrl: 'data:model/gltf-binary;base64,AAAA', transform: pose(0) });
    await waitFor(() => objectIn(bob, 'sofa'), 'sofa');

    bob.send('object:hold', { id: 'sofa' });
    await waitFor(() => objectIn(ada, 'sofa')?.heldBy === 'dev:bob', 'bob holds');

    ada.send('object:hold', { id: 'sofa' });
    await waitFor(() => objectIn(bob, 'sofa')?.overrideBy === 'dev:ada', 'ada overrides');
    check('the admin takes the object, the lock stays with the editor', () => {
        assert.equal(objectIn(bob, 'sofa').heldBy, 'dev:bob');
        assert.equal(objectIn(bob, 'sofa').overrideBy, 'dev:ada');
    });

    ada.send('object:transform', { id: 'sofa', ...pose(4) });
    await waitFor(() => bob.got('object:transform', (p) => p.position[0] === 4), 'ada moves');
    check('the admin moves it', () => {});

    bob.send('object:transform', { id: 'sofa', ...pose(9) });
    await waitFor(() => bob.got('object:denied', (p) => p.id === 'sofa'), 'bob waits');
    check('the editor waits while the admin has it', () => {
        assert.match(last(bob, 'object:denied').reason, /Ada \(admin\) is moving this object/);
    });

    ada.send('object:release', { id: 'sofa' });
    await waitFor(() => objectIn(bob, 'sofa')?.overrideBy === null, 'ada lets go');
    bob.send('object:transform', { id: 'sofa', ...pose(2) });
    await waitFor(() => ada.got('object:transform', (p) => p.position[0] === 2), 'bob moves again');
    check('when the admin lets go, the editor carries on with the lock', () => {
        assert.equal(objectIn(ada, 'sofa').heldBy, 'dev:bob');
    });

    clearInterval(keepAlive);


    console.log('\nInactive people are taken out');

    const keepBob = setInterval(() => bob.send('activity'), 1000);
    const keepEve = setInterval(() => eve.send('activity'), 1000);

    await waitFor(() => ada.got('session:idle-warning'), 'ada warned', 8000);
    check('a warning comes before the end', () => {
        const { secondsLeft } = last(ada, 'session:idle-warning');
        assert.ok(secondsLeft > 0 && secondsLeft <= 4, `secondsLeft ${secondsLeft}`);
    });

    await waitFor(() => ada.leftCode !== null, 'ada out', 8000);
    check('after the idle time they are taken out (4105)', () => assert.equal(ada.leftCode, 4105));

    await waitFor(() => bob.state.you.role === 'admin', 'bob admin');
    check('the last admin going idle hands admin to the oldest editor', () => {
        assert.equal(eve.state.you.role, 'editor');
        assert.equal(bob.state.owner.name, 'Ada');
        assert.equal(eve.leftCode, null);
    });

    const ada2 = await connect('Ada', KEY);
    check('they can come back with the link, keeping their role', () => assert.equal(ada2.state.you.role, 'admin'));

    clearInterval(keepBob);
    clearInterval(keepEve);


    console.log(`\nAll ${passed} admin rule checks passed`);
}


main()
    .then(async () => {
        await stopServer();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog);
        await stopServer();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(1);
    });
