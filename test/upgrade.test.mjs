/*
 * Session upgrade + generation charge test (based on
 * credits.test.mjs helpers)
 * --------------------------------------------------
 * Starting a session (type + pool), paying to enter,
 * the pool paying entries, topping the pool up and
 * GET /credits/mine. Every new person starts with
 * CREDITS_START credits (5 here).
 *
 *   node test/credits.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';




const PORT = 3600 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;

const MB = 1024 * 1024;

// Saves by hand need a few seconds between them
const SAVE_PAUSE = 3100;


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

async function versionsOf(user) {

    const before = user.messages.length;

    user.send('scene:versions');

    await waitFor(
        () => user.messages.slice(before).some((m) => m.type === 'scene:versions'),
        `${user.name} gets the version list`
    );

    return user.messages.slice(before).find((m) => m.type === 'scene:versions').payload.versions;
}

async function approve(admin, user, role) {

    admin.send('join:approve', { userId: `dev:${user.name.toLowerCase()}`, role });

    await waitFor(() => user.state.you.status === 'approved', `${user.name} approved`);
}


// ==================================================
// SERVER
// ==================================================


// The person's fixed test account goes in X-Identity
async function api(method, userId, name, pathname) {

    const res = await fetch(`${URL}${pathname}`, {
        method,
        headers: { 'X-Identity': JSON.stringify({ userId, name }) }
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

const wallet = async (name) => (await api('GET', name.toLowerCase(), name, '/credits/mine')).json;

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-upgrade-test-'));

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
        AUTOSAVE_MINUTES: '60',
        RECONNECT_WINDOW: '1',
        CREDITS_START: '10'
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

    console.log('\nUpgrading');

    const KEY = 'upgrade-session-0001';

    // single (1) -> balance 9
    const ada = await connect('Ada', KEY, 'create', { sessionType: 'single', sessionName: 'Grow' });
    check('a single session starts with 1 person', () => {
        assert.equal(ada.state.sessionType, 'single');
        assert.equal(ada.state.limits.people, 1);
        assert.equal(ada.state.credits.balance, 9);
    });

    ada.send('session:upgrade', { to: 'single' });
    await sleep(200);
    check('upgrading to the same type is refused', () => {
        assert.ok(ada.got('action:denied', (p) => p.type === 'session:upgrade'));
    });

    ada.send('session:upgrade', { to: 'basic', creditPool: 2, poolForEntry: true });
    await waitFor(() => ada.state.sessionType === 'basic', 'upgraded to basic');
    check('single -> basic costs 1 plus the pool, limits grow', () => {
        assert.equal(ada.state.credits.balance, 6);
        assert.equal(ada.state.limits.people, 8);
        assert.deepEqual(ada.state.credits.pool, { total: 2, left: 2, forEntry: true, forModels: false });
        assert.ok(ada.got('session:upgraded', (p) => p.from === 'single' && p.to === 'basic' && p.cost === 1 && p.pool === 2));
    });

    const bob = await connect('Bob', KEY);
    await approve(ada, bob, 'editor');
    check('a second person can join after the upgrade (pool pays entry)', () => {
        assert.equal(bob.state.you.status, 'approved');
        assert.equal(bob.state.credits.pool.left, 1);
    });

    bob.send('session:upgrade', { to: 'workshop' });
    await sleep(200);
    check('only admins upgrade', () => {
        assert.ok(bob.got('action:denied', (p) => p.type === 'session:upgrade'));
        assert.equal(bob.state.sessionType, 'basic');
    });

    ada.send('session:upgrade', { to: 'single' });
    await sleep(200);
    check('downgrades are refused', () => {
        assert.ok(ada.got('action:denied', (p) => p.type === 'session:upgrade' && /downgraded/.test(p.reason)));
        assert.equal(ada.state.sessionType, 'basic');
    });

    ada.send('session:upgrade', { to: 'workshop', creditPool: 100 });
    await sleep(200);
    check('an upgrade you cannot afford changes nothing', () => {
        assert.equal(ada.state.sessionType, 'basic');
        assert.equal(ada.state.credits.balance, 6);
    });

    ada.send('session:upgrade', { to: 'workshop' });
    await waitFor(() => bob.state.sessionType === 'workshop', 'upgraded to workshop');
    check('basic -> workshop costs 1, everyone sees it', () => {
        assert.equal(ada.state.credits.balance, 5);
        assert.equal(bob.state.limits.people, 50);
        assert.ok(bob.got('session:upgraded', (p) => p.to === 'workshop'));
    });


    console.log('\nGeneration charge');

    bob.send('generation:charge', { requestId: 'r1', cost: 1 });
    await waitFor(() => bob.got('generation:charged') || bob.got('generation:denied'), 'r1');
    check('pool does not cover models -> the person pays', () => {
        assert.ok(bob.got('generation:charged', (p) => p.requestId === 'r1' && p.paidBy === 'self'));
    });

    ada.send('credits:pool', { forModels: true });
    await waitFor(() => ada.state.credits.pool.forModels, 'pool covers models');
    bob.send('generation:charge', { requestId: 'r2', cost: 1 });
    await waitFor(() => bob.got('generation:charged', (p) => p.requestId === 'r2'), 'r2');
    check('pool covers models -> the pool pays', () => {
        assert.ok(bob.got('generation:charged', (p) => p.requestId === 'r2' && p.paidBy === 'pool'));
    });

    // The price is the server's: a client cost of 0 (or 500) changes nothing
    bob.send('generation:charge', { requestId: 'r3', cost: 0 });
    await waitFor(() => bob.got('generation:charged', (p) => p.requestId === 'r3'), 'r3');
    check('a client cost of 0 is not free', () => {
        assert.ok(bob.got('generation:charged', (p) => p.requestId === 'r3' && p.cost === 1 && p.paidBy !== 'free'));
    });

    bob.send('generation:charge', { requestId: 'r4', cost: 500 });
    await waitFor(() => bob.got('generation:charged', (p) => p.requestId === 'r4'), 'r4');
    check('a client cost of 500 is charged the server price', () => {
        assert.ok(bob.got('generation:charged', (p) => p.requestId === 'r4' && p.cost === 1));
    });

    bob.send('generation:charge', { requestId: 'r4', cost: 1 });
    await waitFor(() => bob.got('generation:denied', (p) => p.requestId === 'r4'), 'r4 again');
    check('the same generation is never paid twice', () => assert.ok(true));

    ada.room.leave();
    bob.room.leave();

    console.log(`\nAll ${passed} upgrade checks passed`);
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
        await sleep(500);
        console.error('\n--- server log ---\n' + serverLog);
        await stopServer();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(1);
    });
