/*
 * Model files + session type limits test
 * --------------------------------------------------
 * Starts the server on a spare port with local storage
 * in a temp folder, then checks POST /assets, the
 * download link, object:add { assetId } and the limits
 * of the session types (session-types.mjs).
 *
 *   node test/assets.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 2900 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;

const MB = 1024 * 1024;


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

    const user = { name, room, messages: [], state: null };

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


// ==================================================
// SERVER
// ==================================================

const storageDir = await mkdtemp(path.join(tmpdir(), 'be-water-assets-test-'));

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
        SCENE_LOCAL_DIR: path.join(storageDir, 'scenes')
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';

server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));


async function main() {

    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);


    console.log('\nSession types');

    const KEY = 'assets-session-0001';

    const ada = await connect('Ada', KEY, 'create', { sessionType: 'basic' });

    check('state tells the type, its limits and that uploads are supported', () => {
        assert.equal(ada.state.sessionType, 'basic');
        assert.deepEqual(ada.state.limits, { people: 8, maxBytes: 250 * MB, fileBytes: 50 * MB });
        assert.equal(ada.state.usedBytes, 0);
        assert.equal(ada.state.features.assetUploads, true);
    });

    const old = await connect('Olga', 'assets-session-0002', 'create');
    check('a session made without a type is basic', () => assert.equal(old.state.sessionType, 'basic'));
    old.room.leave();

    const solo = await connect('Sam', 'assets-session-0003', 'create', { sessionType: 'single' });
    const second = await connect('Tom', 'assets-session-0003').then(() => null, (e) => e);
    check('a single-user session lets nobody else in', () => {
        assert.equal(solo.state.sessionType, 'single');
        assert.equal(second?.code, 403);
        assert.match(second.message, /full/);
    });

    const solo2 = await connect('Sam', 'assets-session-0003');
    check('the same person in a second browser still gets in', () => assert.equal(solo2.state.you.role, 'admin'));
    solo.room.leave();
    solo2.room.leave();


    console.log('\nUploading model files');

    const bob = await connect('Bob', KEY);
    const vic = await connect('Vic', KEY);

    ada.send('join:approve', { userId: 'dev:bob', role: 'editor' });
    ada.send('join:approve', { userId: 'dev:vic', role: 'viewer' });

    await waitFor(() => bob.state.you.ticket && vic.state.you.ticket, 'approved');

    const glb = fakeGlb(4096, 1);

    const anonymous = await upload(null, glb);
    check('upload without a ticket is refused (401)', () => assert.equal(anonymous.status, 401));

    const byViewer = await upload(vic.state.you.ticket, glb);
    check('viewers cannot upload (403)', () => assert.equal(byViewer.status, 403));

    const notGlb = await upload(bob.state.you.ticket, Buffer.from('hello, this is not a model file'));
    check('a file that is not a GLB is refused (415)', () => assert.equal(notGlb.status, 415));

    const up = await upload(bob.state.you.ticket, glb, 'chair.glb');
    check('an editor uploads a GLB and gets its id, size and link', () => {
        assert.equal(up.status, 200);
        assert.match(up.json.assetId, /^[0-9a-f]{64}$/);
        assert.equal(up.json.size, 4096);
        assert.match(up.json.url, new RegExp(`/assets/[A-Za-z0-9_-]{20,64}/${up.json.assetId}\\.glb$`));
    });

    const download = await fetch(up.json.url);
    const bytes = Buffer.from(await download.arrayBuffer());
    check('the link gives back the same file', () => {
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('content-type'), 'model/gltf-binary');
        assert.ok(bytes.equals(glb));
    });

    const missing = await fetch(up.json.url.replace(/[0-9a-f]{64}/, 'f'.repeat(64)));
    check('an unknown model link is 404', () => assert.equal(missing.status, 404));

    const again = await upload(ada.state.you.ticket, glb, 'chair copy.glb');
    check('the same file uploaded again gets the same id', () => assert.equal(again.json.assetId, up.json.assetId));


    console.log('\nSharing a model by its id');

    bob.send('object:add', { id: 'chair', name: 'chair.glb', assetId: up.json.assetId, transform: POSE });

    await waitFor(() => ada.got('object:add', (o) => o.id === 'chair'), 'chair reaches Ada');

    check('others receive the link, not the file', () => {
        const added = ada.messages.find((m) => m.type === 'object:add' && m.payload.id === 'chair').payload;
        assert.equal(added.url, up.json.url);
        assert.equal(added.size, 4096);
        assert.equal(added.dataUrl, undefined);
        assert.deepEqual(added.transform, POSE);
    });

    await waitFor(() => ada.state.usedBytes === 4096, 'usage counted');
    check('the session counts the file size', () => assert.equal(ada.state.usedBytes, 4096));

    bob.send('object:add', { id: 'chair2', name: 'chair.glb', assetId: up.json.assetId });
    await waitFor(() => ada.got('object:add', (o) => o.id === 'chair2'), 'chair2');
    await sleep(100);
    check('a file used twice counts once', () => assert.equal(ada.state.usedBytes, 4096));

    bob.send('object:add', { id: 'fake', name: 'fake.glb', assetId: 'a'.repeat(64) });
    await sleep(300);
    check('an id that was never uploaded to this session is ignored', () => {
        assert.equal(ada.got('object:add', (o) => o.id === 'fake'), false);
    });

    ada.send('object:add', { id: 'old', name: 'old.glb', dataUrl: 'data:model/gltf-binary;base64,AAAA' });
    await waitFor(() => bob.got('object:add', (o) => o.id === 'old'), 'legacy model');
    check('models from older clients (data URL) still work', () => {
        const added = bob.messages.find((m) => m.type === 'object:add' && m.payload.id === 'old').payload;
        assert.equal(added.dataUrl, 'data:model/gltf-binary;base64,AAAA');
    });

    const late = await connect('Lea', KEY);
    ada.send('join:approve', { userId: 'dev:lea', role: 'viewer' });
    await waitFor(() => late.state.you.status === 'approved', 'Lea approved');
    late.send('sync-request', { have: [] });
    await waitFor(() => late.got('object:add', (o) => o.id === 'chair'), 'Lea syncs');
    check('someone joining later gets the link on sync', () => {
        const added = late.messages.find((m) => m.type === 'object:add' && m.payload.id === 'chair').payload;
        assert.equal(added.url, up.json.url);
    });


    console.log('\nSize limits');

    const big = await upload(bob.state.you.ticket, fakeGlb(50 * MB + 1, 2), 'huge.glb');
    check('a file over 50 MB is refused (413)', () => {
        assert.equal(big.status, 413);
    });

    // Fill the 250 MB of a basic session: 4 x 50 MB + what
    // is already there, then one more file goes over.
    for (let i = 0; i < 4; i++) {

        const part = await upload(bob.state.you.ticket, fakeGlb(50 * MB, 10 + i), `part${i}.glb`);

        assert.equal(part.status, 200, part.text);

        bob.send('object:add', { id: `part${i}`, name: `part${i}.glb`, assetId: part.json.assetId });
    }

    await waitFor(() => ada.state.usedBytes >= 200 * MB, 'parts counted', 10000);

    const fifth = await upload(bob.state.you.ticket, fakeGlb(50 * MB, 20), 'one-too-many.glb');
    check('an upload that would go over the session total is refused (413)', () => {
        assert.equal(fifth.status, 413);
        assert.match(fifth.text, /session is full/);
    });

    const small = await upload(bob.state.you.ticket, fakeGlb(MB, 21), 'small.glb');
    check('a file that still fits is accepted', () => assert.equal(small.status, 200));

    bob.send('object:remove', { id: 'part0' });
    await waitFor(() => ada.state.usedBytes < 200 * MB, 'space freed');
    check('deleting a model frees its space', () => assert.ok(ada.state.usedBytes < 200 * MB));


    console.log(`\nAll ${passed} asset checks passed`);
}


main()
    .then(async () => {
        server.kill();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog);
        server.kill();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(1);
    });
