/*
 * Object display names (object:rename)
 * --------------------------------------------------
 * Starts the server with local storage in a temp folder. A rename by an
 * editor reaches every member; a refused rename (someone else holds the
 * object, a viewer, an invalid name) changes nothing and tells the sender
 * the name to snap back to; the name survives closing and re-opening the
 * session; the object's id and model file never change.
 *
 *   node test/object-rename.test.mjs
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

async function connect(name, sessionKey, mode = 'join') {
    const client = new Client(URL);
    const room = await client[mode]('session', { sessionKey, identity: { userId: name.toLowerCase(), name } });
    const user = { name, room, messages: [], state: null, leftCode: null };
    room.onLeave((code) => { user.leftCode = code; });
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.got = (type, pred = () => true) => user.messages.some((m) => m.type === type && pred(m.payload));
    user.send = (type, data = {}) => room.send(type, data);
    await waitFor(() => user.state, `${name} gets session:state`);
    return user;
}

function fakeGlb(size, seed = 0) {
    const body = Buffer.alloc(size, seed & 0xff);
    body.writeUInt32LE(0x46546C67, 0);
    body.writeUInt32LE(2, 4);
    body.writeUInt32LE(size, 8);
    body.writeUInt32LE(seed, 12);
    return body;
}

async function upload(ticket, body, name) {
    const res = await fetch(`${URL}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${ticket}` },
        body
    });
    return res.json();
}

const pose = (x) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
const objectIn = (user, id) => user.state.objects?.find((o) => o.id === id);
const last = (user, type, pred = () => true) =>
    [...user.messages].reverse().find((m) => m.type === type && pred(m.payload))?.payload;

async function approve(admin, user, role) {
    admin.send('join:approve', { userId: `dev:${user.name.toLowerCase()}`, role });
    await waitFor(() => user.state.you.status === 'approved', `${user.name} approved`);
}


const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-rename-test-'));

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'dev',
        ALLOW_DEV_AUTH: 'true',
        MAIL_PROVIDER: 'log',
        SCENE_STORAGE: 'local',
        SCENE_LOCAL_DIR: path.join(storageDir, 'scenes'),
        RECONNECT_WINDOW: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

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

    const KEY = 'rename-session-0001';
    const ada = await connect('Ada', KEY, 'create');
    const bob = await connect('Bob', KEY);
    const eve = await connect('Eve', KEY);
    const vic = await connect('Vic', KEY);
    await approve(ada, bob, 'editor');
    await approve(ada, eve, 'editor');
    await approve(ada, vic, 'viewer');

    const chair = await upload(bob.state.you.ticket, fakeGlb(2048, 1), 'BeeStoon_MD_0001_quad.glb');
    bob.send('object:add', { id: 'chair', name: 'BeeStoon_MD_0001_quad.glb', assetId: chair.assetId, transform: pose(1) });
    await waitFor(() => objectIn(ada, 'chair') && objectIn(vic, 'chair'), 'chair added');
    const assetBefore = chair.assetId;


    console.log('\nRenaming');

    bob.send('object:rename', { id: 'chair', name: '  Lobby chair  ' });
    await waitFor(() => ada.got('object:rename') && vic.got('object:rename') && eve.got('object:rename'), 'rename broadcast');
    await waitFor(() => [ada, bob, eve, vic].every((u) => objectIn(u, 'chair')?.name === 'Lobby chair'), 'state updated');
    check('an editor\'s rename reaches every other member (trimmed)', () => {
        for (const u of [ada, eve, vic]) {
            assert.deepEqual(last(u, 'object:rename'), { id: 'chair', name: 'Lobby chair' });
        }
    });
    check('the authoritative state (the Objects panel list) carries the new name for everyone', () => {
        for (const u of [ada, bob, eve, vic]) {
            assert.equal(objectIn(u, 'chair').name, 'Lobby chair');
        }
    });

    bob.send('object:rename', { id: 'chair', name: 'Lobby chair' });
    await sleep(300);
    check('renaming to the same name sends nothing', () => {
        assert.equal(ada.messages.filter((m) => m.type === 'object:rename').length, 1);
    });


    console.log('\nRefused renames snap back');

    bob.send('object:hold', { id: 'chair' });
    await waitFor(() => objectIn(eve, 'chair')?.heldBy === 'dev:bob', 'bob holds');
    eve.send('object:rename', { id: 'chair', name: 'Eve was here' });
    await waitFor(() => eve.got('object:denied', (d) => d.id === 'chair'), 'eve denied');
    check('a rename of an object someone else holds is refused with the name to snap back to', () => {
        const d = last(eve, 'object:denied', (p) => p.id === 'chair');
        assert.equal(d.name, 'Lobby chair');
        assert.match(d.reason, /Bob/);
    });

    vic.send('object:rename', { id: 'chair', name: 'Viewer name' });
    await waitFor(() => vic.got('object:denied', (d) => d.id === 'chair'), 'viewer denied');
    check('a viewer cannot rename', () => assert.equal(last(vic, 'object:denied', (p) => p.id === 'chair').name, 'Lobby chair'));

    bob.send('object:rename', { id: 'chair', name: '   ' });
    bob.send('object:rename', { id: 'chair', name: 'x'.repeat(201) });
    bob.send('object:rename', { id: 'nope', name: 'Ghost' });
    await sleep(300);
    check('blank, over-long or unknown-object renames change nothing for anyone', () => {
        assert.equal(objectIn(ada, 'chair').name, 'Lobby chair');
        assert.equal(ada.messages.filter((m) => m.type === 'object:rename').length, 1);
    });
    check('nobody\'s refused rename reached anyone else', () => {
        assert.ok(!ada.got('object:rename', (p) => p.name === 'Eve was here' || p.name === 'Viewer name'));
    });

    // A second, identically named object keeps its own identity
    const lamp = await upload(bob.state.you.ticket, fakeGlb(1024, 2), 'lamp.glb');
    bob.send('object:add', { id: 'lamp', name: 'lamp.glb', assetId: lamp.assetId, transform: pose(2) });
    await waitFor(() => objectIn(ada, 'lamp'), 'lamp added');
    bob.send('object:rename', { id: 'lamp', name: 'Lobby chair' });
    await waitFor(() => objectIn(ada, 'lamp')?.name === 'Lobby chair', 'duplicate name');
    check('two objects may share a display name without mixing them up', () => {
        assert.equal(ada.state.objects.filter((o) => o.name === 'Lobby chair').length, 2);
        assert.deepEqual(ada.state.objects.map((o) => o.id).sort(), ['chair', 'lamp']);
    });


    console.log('\nSaved and re-opened');

    ada.send('session:leave', { choice: 'close' });
    await waitFor(() => bob.leftCode !== null, 'closed');
    await sleep(500);

    const ada2 = await connect('Ada', KEY, 'create');
    ada2.send('sync-request', { have: [] });
    await waitFor(() => ada2.got('object:add', (p) => p.id === 'chair'), 'reopened chair');
    check('the renamed name survives closing and re-opening the session', () => {
        assert.equal(last(ada2, 'object:add', (p) => p.id === 'chair').name, 'Lobby chair');
        assert.equal(last(ada2, 'object:add', (p) => p.id === 'chair').assetId, assetBefore);  // same model file
    });

    console.log(`\nAll ${passed} rename checks passed`);
}

main()
    .then(async () => {
        await stopServer();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('\nFAILED:', error);
        console.error('\n--- server log ---\n' + serverLog.slice(-3000));
        await stopServer();
        await rm(storageDir, { recursive: true, force: true }).catch(() => {});
        process.exit(1);
    });
