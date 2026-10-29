/*
 * Credits test
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

const storageDir = await mkdtemp(path.join(tmpdir(), 'be-water-credits-test-'));

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
        CREDITS_START: '5'
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


    console.log('\nYour credits');

    const fresh = await wallet('Ada');
    check('a new person starts with CREDITS_START credits', () => {
        assert.equal(fresh.enabled, true);
        assert.equal(fresh.balance, 5);
        assert.deepEqual(fresh.sessionCosts, { single: 1, basic: 2, workshop: 3 });
        assert.equal(fresh.entryCost, 1);
    });


    console.log('\nStarting a session');

    const tooBig = await connect('Ada', 'credit-session-0000', 'create', {
        sessionType: 'workshop', creditPool: 3
    }).then(() => null, (e) => e);
    check('a session plus pool you cannot afford is refused (402), nothing taken', () => {
        assert.ok(tooBig);
        assert.equal(tooBig.code, 402);
        assert.match(tooBig.message, /need 6 credits/);
    });
    const after = await wallet('Ada');
    check('... and nothing is taken', () => assert.equal(after.balance, 5));

    const KEY = 'credit-session-0001';

    const ada = await connect('Ada', KEY, 'create', {
        sessionType: 'basic', sessionName: 'Paid', creditPool: 2, poolForEntry: false, poolForModels: true
    });
    check('the creator pays the type (basic 2) and the pool (2)', () => {
        assert.equal(ada.state.credits.balance, 1);
        assert.deepEqual(ada.state.credits.pool, { total: 2, left: 2, forEntry: false, forModels: true });
        assert.equal(ada.state.credits.sessionCost, 2);
    });

    const ada2 = await connect('Ada', KEY);
    await sleep(100);
    check('a second browser of the creator costs nothing', () => {
        assert.equal(ada2.state.credits.balance, 1);
    });
    ada2.room.leave();


    console.log('\nEntering');

    const bob = await connect('Bob', KEY);
    await approve(ada, bob, 'editor');
    check('with the pool not covering entries, the invitee pays 1', () => {
        assert.equal(bob.state.credits.balance, 4);
        assert.equal(bob.state.credits.pool.left, 2);
    });

    ada.send('credits:pool', { forEntry: true });
    await waitFor(() => ada.state.credits.pool.forEntry, 'pool covers entries');

    const cy = await connect('Cy', KEY);
    await approve(ada, cy, 'viewer');
    check('once the admin lets the pool cover entries, the pool pays', () => {
        assert.equal(cy.state.credits.balance, 5);
        assert.equal(cy.state.credits.pool.left, 1);
    });

    const dee = await connect('Dee', KEY);
    await approve(ada, dee, 'viewer');
    const eve = await connect('Eve', KEY);
    await approve(ada, eve, 'viewer');
    check('when the pool is used up, invitees pay themselves again', () => {
        assert.equal(dee.state.credits.balance, 5);
        assert.equal(eve.state.credits.balance, 4);
        assert.equal(eve.state.credits.pool.left, 0);
    });

    bob.room.leave();
    await waitFor(() => bob.leftCode !== null, 'bob left');
    const bobBack = await connect('Bob', KEY);
    await sleep(100);
    check('coming back to the same session is free', () => {
        assert.equal(bobBack.state.credits.balance, 4);
    });


    console.log('\nPeople without credits');

    // Fay spends her 5 on a workshop + pool of 2
    const fay = await connect('Fay', 'credit-session-0002', 'create', { sessionType: 'workshop', creditPool: 2 });
    check('Fay spends all her credits', () => assert.equal(fay.state.credits.balance, 0));

    const fayIn = await connect('Fay', KEY).then(() => null, (e) => e);
    check('someone with no credits cannot ask to join when the pool cannot pay (402)', () => {
        assert.ok(fayIn);
        assert.equal(fayIn.code, 402);
        assert.match(fayIn.message, /need 1 credit/);
    });


    console.log('\nTopping up the pool');

    ada.send('credits:add', { amount: 5 });
    await sleep(200);
    check('more than the admin has is refused', () => {
        assert.ok(ada.got('action:denied', (p) => p.type === 'credits:add'));
        assert.equal(ada.state.credits.pool.total, 2);
    });

    ada.send('credits:add', { amount: 1 });
    await waitFor(() => ada.state.credits.pool.total === 3, 'pool topped up');
    check('the admin adds from their own credits', () => {
        assert.equal(ada.state.credits.balance, 0);
        assert.equal(ada.state.credits.pool.left, 1);
    });

    const fay2 = await connect('Fay', KEY);
    await approve(ada, fay2, 'viewer');
    check('now the pool pays Fay in', () => {
        assert.equal(fay2.state.credits.balance, 0);
        assert.equal(fay2.state.credits.pool.left, 0);
    });

    bobBack.send('credits:add', { amount: 1 });
    await sleep(200);
    check('only admins top up the pool', () => {
        assert.ok(bobBack.got('action:denied', (p) => p.type === 'credits:add'));
    });


    console.log('\nThe pool is saved with the session');

    const chair = await upload(ada.state.you.ticket, fakeGlb(2000, 1), 'chair.glb');
    ada.send('object:add', { id: 'chair', name: 'chair.glb', assetId: chair.json.assetId, transform: pose(1) });
    await waitFor(() => objectIn(ada, 'chair'), 'chair added');

    ada.send('scene:save', { name: 'With pool' });
    await waitFor(() => ada.state.scene.saved || ada.got('action:denied', (p) => p.type === 'scene:save'), 'saved');
    assert.ok(ada.state.scene.saved, JSON.stringify(ada.messages.filter((m) => m.type === 'action:denied')));
    for (const u of [ada, bobBack, cy, dee, eve, fay, fay2]) {
        u.room.leave();
    }
    await sleep(600);

    const again = await connect('Ada', KEY, 'create');
    check('re-opening a saved session costs nothing and keeps the pool', () => {
        assert.equal(again.state.credits.balance, 0);
        assert.deepEqual(again.state.credits.pool, { total: 3, left: 0, forEntry: true, forModels: true });
    });

    const eveBack = await connect('Eve', KEY);
    await sleep(100);
    check('earlier attendees come back without paying', () => {
        assert.equal(eveBack.state.you.status, 'approved');
        assert.equal(eveBack.state.credits.balance, 4);
    });

    again.room.leave();
    eveBack.room.leave();


    console.log(`\nAll ${passed} credit checks passed`);
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
