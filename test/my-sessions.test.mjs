/*
 * My sessions test
 * --------------------------------------------------
 * GET /sessions/mine (live + saved sessions of the
 * person asking) and owner-only DELETE /sessions/<key>.
 *
 *   node test/my-sessions.test.mjs
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

const mine = (name) => api('GET', name.toLowerCase(), name, '/sessions/mine');


// ==================================================
// SERVER
// ==================================================

const storageDir = await mkdtemp(path.join(tmpdir(), 'be-water-mine-test-'));

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
        RECONNECT_WINDOW: '1'
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


    console.log('\nAsking who you are');

    const noOne = await fetch(`${URL}/sessions/mine`);
    check('without an identity the list is refused (401)', () => assert.equal(noOne.status, 401));

    const empty = await mine('Ada');
    check('someone with no sessions gets two empty lists', () => {
        assert.equal(empty.status, 200);
        assert.deepEqual(empty.json, { live: [], saved: [] });
    });


    console.log('\nSessions you are in right now');

    const KEY = 'mine-session-0001';
    const OTHER = 'mine-session-0002';

    const ada = await connect('Ada', KEY, 'create', { sessionName: 'Lobby design', sessionType: 'basic' });
    const bob = await connect('Bob', KEY);
    const vic = await connect('Vic', KEY);

    await approve(ada, bob, 'editor');

    const bea = await connect('Bea', OTHER, 'create', { sessionName: 'Garden', sessionType: 'workshop' });
    const bob2 = await connect('Bob', OTHER);
    await approve(bea, bob2, 'viewer');

    const bobList = await mine('Bob');
    check('every live session you are in shows, with your role in each', () => {
        const byKey = Object.fromEntries(bobList.json.live.map((s) => [s.sessionKey, s]));
        assert.equal(bobList.json.live.length, 2);
        assert.equal(byKey[KEY].role, 'editor');
        assert.equal(byKey[KEY].sessionName, 'Lobby design');
        assert.equal(byKey[KEY].sessionType, 'basic');
        assert.deepEqual(byKey[KEY].owner, { name: 'Ada' });
        assert.equal(byKey[KEY].isOwner, false);
        assert.equal(byKey[OTHER].role, 'viewer');
        assert.equal(byKey[OTHER].sessionType, 'workshop');
    });

    const adaList = await mine('Ada');
    check('the creator sees it as owner, with how many are in', () => {
        assert.equal(adaList.json.live.length, 1);
        assert.equal(adaList.json.live[0].isOwner, true);
        assert.equal(adaList.json.live[0].role, 'admin');
        assert.equal(adaList.json.live[0].people, 2);
        assert.equal(adaList.json.live[0].online, 2);
    });

    const vicList = await mine('Vic');
    check('someone still waiting for approval does not see it', () => assert.equal(vicList.json.live.length, 0));

    check('nobody sees the private scene id', () => {
        assert.equal(JSON.stringify(bobList.json).includes('sceneId'), false);
    });


    console.log('\nSaved sessions');

    const chair = await upload(bob.state.you.ticket, fakeGlb(2048, 1), 'chair.glb');
    bob.send('object:add', { id: 'chair', name: 'chair.glb', assetId: chair.json.assetId, transform: pose(1) });
    await waitFor(() => objectIn(ada, 'chair'), 'chair added');

    bob.send('scene:save', { name: 'First layout', description: 'Chair by the door' });
    await waitFor(() => ada.got('scene:saved'), 'saved');

    const saved = (await mine('Bob')).json.saved;
    check('a saved session shows for everyone who was in it', () => {
        assert.equal(saved.length, 1);
        const s = saved[0];
        assert.equal(s.sessionKey, KEY);
        assert.equal(s.name, 'Lobby design');
        assert.equal(s.isOwner, false);
        assert.deepEqual(s.owner, { name: 'Ada' });
        assert.equal(s.live, true);
        assert.equal(s.versionCount, 1);
        assert.ok(s.createdAt && s.lastActivity);
    });

    check('with its last checkpoint: name, note, when and by whom', () => {
        assert.deepEqual(saved[0].latest, {
            name: 'First layout',
            description: 'Chair by the door',
            createdAt: saved[0].latest.createdAt,
            savedBy: { name: 'Bob' }
        });
    });

    check('with the people in it, the owner marked', () => {
        const names = saved[0].attendees.map((a) => a.name).sort();
        assert.deepEqual(names, ['Ada', 'Bob']);
        assert.equal(saved[0].attendees.find((a) => a.name === 'Ada').isOwner, true);
        assert.equal(saved[0].attendees.find((a) => a.name === 'Bob').role, 'editor');
        assert.equal(JSON.stringify(saved[0].attendees).includes('dev:'), false);
    });

    const outsider = await mine('Zed');
    check('someone who was never in it does not see it', () => assert.equal(outsider.json.saved.length, 0));


    console.log('\nDeleting a saved session');

    const whileOpen = await api('DELETE', 'ada', 'Ada', `/sessions/${KEY}`);
    check('it cannot be deleted while it is open (409)', () => assert.equal(whileOpen.status, 409));

    ada.send('session:leave', { choice: 'close' });
    await waitFor(() => bob.leftCode !== null, 'closed');
    await sleep(300);

    const afterClose = (await mine('Bob')).json;
    check('after closing, it leaves the live list but stays saved', () => {
        assert.equal(afterClose.live.some((s) => s.sessionKey === KEY), false);
        assert.equal(afterClose.saved.length, 1);
        assert.equal(afterClose.saved[0].live, false);
    });

    const byBob = await api('DELETE', 'bob', 'Bob', `/sessions/${KEY}`);
    check('only the owner can delete it (403)', () => {
        assert.equal(byBob.status, 403);
        assert.match(byBob.text, /owner \(Ada\)/);
    });

    const unknown = await api('DELETE', 'ada', 'Ada', '/sessions/no-such-session-99');
    check('an unknown session is 404', () => assert.equal(unknown.status, 404));

    const byAda = await api('DELETE', 'ada', 'Ada', `/sessions/${KEY}`);
    check('the owner deletes it', () => {
        assert.equal(byAda.status, 200);
        assert.deepEqual(byAda.json, { deleted: KEY });
    });

    const gone = [await mine('Ada'), await mine('Bob')];
    check('it is gone from everyone\'s list', () => {
        assert.equal(gone[0].json.saved.length, 0);
        assert.equal(gone[1].json.saved.length, 0);
    });

    const model = await fetch(chair.json.url);
    check('its model files are deleted too', () => assert.equal(model.status, 404));

    const reopen = await connect('Ada', KEY, 'create').then(() => null, (e) => e);
    check('a deleted session\'s link stays closed', () => {
        assert.ok(reopen);
        assert.match(reopen.message, /closed/);
    });

    bea.room.leave();
    bob2.room.leave();
    vic.room.leave();


    console.log(`\nAll ${passed} my-sessions checks passed`);
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
