/*
 * Saving, versions and re-opening test
 * --------------------------------------------------
 * Starts the server with local storage in a temp
 * folder and a short autosave time, then saves named
 * versions, restores them (admins only), lets the
 * session close, and re-opens it as its owner.
 *
 *   node test/versions.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3200 + Math.floor(Math.random() * 300);
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

const storageDir = await mkdtemp(path.join(tmpdir(), 'be-water-versions-test-'));

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
        // 3 seconds
        AUTOSAVE_MINUTES: '0.05',
        RECONNECT_WINDOW: '1',
        SAVED_SESSIONS_LIMIT: '3'
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


    console.log('\nA new session');

    const KEY = 'versions-session-01';

    const ada = await connect('Ada', KEY, 'create', { sessionName: 'Lobby design' });
    const bob = await connect('Bob', KEY);
    const vic = await connect('Vic', KEY);

    await approve(ada, bob, 'editor');
    await approve(ada, vic, 'viewer');

    check('the creator is the owner, and the session is not saved yet', () => {
        assert.deepEqual(ada.state.owner, { userId: 'dev:ada', name: 'Ada' });
        assert.deepEqual(bob.state.owner, ada.state.owner);
        assert.equal(ada.state.sessionName, 'Lobby design');
        assert.equal(ada.state.scene.saved, false);
        assert.equal(ada.state.features.versions, true);
        assert.match(ada.state.scene.sceneId, /^[A-Za-z0-9_-]{20,}$/);
        assert.equal(bob.state.scene.sceneId, undefined);
    });

    const chair = await upload(bob.state.you.ticket, fakeGlb(2048, 1), 'chair.glb');
    bob.send('object:add', { id: 'chair', name: 'chair.glb', assetId: chair.json.assetId, transform: pose(1) });
    await waitFor(() => objectIn(ada, 'chair'), 'chair added');


    console.log('\nSaving by hand');

    vic.send('scene:save', { name: 'Nope' });
    await waitFor(() => vic.got('action:denied', (d) => d.type === 'scene:save'), 'viewer refused');
    check('viewers cannot save', () => assert.match(last(vic, 'action:denied').reason, /admins and editors/));

    bob.send('scene:save', { name: '   ' });
    await waitFor(() => bob.got('action:denied', (d) => d.type === 'scene:save'), 'no name refused');
    check('a version needs a name', () => assert.match(last(bob, 'action:denied').reason, /name/));

    bob.send('scene:save', { name: 'First layout', description: 'Chair by the window' });
    await waitFor(() => vic.got('scene:saved'), 'saved');

    check('an editor saves a named version and everyone hears about it', () => {
        const { version } = last(vic, 'scene:saved');
        assert.equal(version.name, 'First layout');
        assert.equal(version.description, 'Chair by the window');
        assert.equal(version.auto, false);
        assert.deepEqual(version.savedBy, { userId: 'dev:bob', name: 'Bob' });
        assert.equal(version.objectCount, 1);
        assert.equal(version.bytes, 2048);
    });

    await waitFor(() => ada.state.scene.saved && !ada.state.scene.saving, 'state after save');
    check('the state shows the latest version (the note in My sessions)', () => {
        assert.equal(ada.state.scene.versionCount, 1);
        assert.equal(ada.state.scene.latest.name, 'First layout');
        assert.equal(ada.state.scene.dirty, false);
    });

    await sleep(SAVE_PAUSE);
    bob.send('object:transform', { id: 'chair', ...pose(5) });
    ada.send('object:add', { id: 'lamp', name: 'lamp.glb', dataUrl: 'data:model/gltf-binary;base64,' + fakeGlb(64, 2).toString('base64') });
    await waitFor(() => objectIn(bob, 'lamp') && ada.state.scene.dirty, 'changes');
    check('changes mark the session as not saved', () => assert.equal(ada.state.scene.dirty, true));

    await sleep(SAVE_PAUSE);
    ada.send('scene:save', { name: 'With lamp' });
    await waitFor(() => bob.got('scene:saved', (p) => p.version.name === 'With lamp'), 'second save');

    const list = await versionsOf(vic);
    check('everyone can see the versions, newest first', () => {
        // (an autosave may sit in between)
        assert.deepEqual(list.filter((v) => !v.auto).map((v) => v.name), ['With lamp', 'First layout']);
    });


    console.log('\nRestoring');

    const first = list.find((v) => v.name === 'First layout');
    const withLamp = list.find((v) => v.name === 'With lamp');

    bob.send('scene:restore', { versionId: first.id });
    await waitFor(() => bob.got('action:denied', (d) => d.type === 'scene:restore'), 'editor refused');
    check('only admins can restore', () => assert.match(last(bob, 'action:denied').reason, /Only admins/));

    bob.messages.length = 0;
    ada.send('scene:restore', { versionId: first.id });
    await waitFor(() => bob.got('scene:restored'), 'restored');

    check('restoring removes what the version did not have and moves the rest back', () => {
        assert.ok(bob.got('object:remove', (p) => p.id === 'lamp'));
        assert.ok(bob.got('object:transform', (p) => p.id === 'chair' && p.position[0] === 1));
        assert.equal(bob.got('object:add', (p) => p.id === 'chair'), false);
        assert.equal(last(bob, 'scene:restored').by, 'Ada');
        assert.match(last(bob, 'session:notice').text, /restored the version "First layout"/);
    });

    await waitFor(() => !objectIn(ada, 'lamp'), 'state after restore');
    const unchanged = await versionsOf(ada);
    check('nothing new was saved because nothing had changed', () => {
        assert.equal(unchanged.some((v) => v.name === 'Before restore'), false);
    });

    await waitFor(() => ada.state.scene.latest?.name === 'Restored "First layout"', 'restored saved');
    check('the restored scene is saved as the latest version (re-opening starts from it)', () => {
        const restored = unchanged.find((v) => v.name === 'Restored "First layout"') ||
            ada.state.scene.latest;
        assert.equal(restored.auto, true);
        assert.equal(restored.objectCount, 1);
        assert.equal(ada.state.scene.dirty, false);
    });

    // Unsaved change, then restore "With lamp"
    bob.send('object:transform', { id: 'chair', ...pose(9) });
    await waitFor(() => ada.state.scene.dirty, 'dirty again');
    bob.messages.length = 0;
    ada.send('scene:restore', { versionId: withLamp.id });
    await waitFor(() => bob.got('scene:restored'), 'restored 2');

    const afterRestore = await versionsOf(ada);
    check('unsaved changes are kept as "Before restore" first', () => {
        const kept = afterRestore.find((v) => v.name === 'Before restore');
        assert.ok(kept);
        assert.equal(kept.auto, true);
        assert.match(kept.description, /before Ada restored "With lamp"/);
    });

    check('a model from an older client comes back as a stored file', () => {
        const lamp = last(bob, 'object:add', (p) => p.id === 'lamp');
        assert.ok(lamp);
        assert.match(lamp.assetId, /^[0-9a-f]{64}$/);
        assert.equal(lamp.dataUrl, undefined);
        assert.equal(lamp.size, 64);
    });

    const lampFile = await fetch(last(bob, 'object:add', (p) => p.id === 'lamp').url);
    check('and its link works', () => assert.equal(lampFile.status, 200));


    console.log('\nAutosave');

    bob.messages.length = 0;
    bob.send('object:transform', { id: 'chair', ...pose(7) });
    await waitFor(() => bob.got('scene:saved', (p) => p.version.auto), 'autosave', 8000);
    check('changes are autosaved after a while', () => {
        const { version } = last(bob, 'scene:saved', (p) => p.version.auto);
        assert.equal(version.name, 'Autosave');
        assert.equal(version.savedBy.name, 'Autosave');
    });


    console.log('\nClosing and re-opening');

    bob.send('object:transform', { id: 'chair', ...pose(3) });
    await waitFor(() => ada.state.scene.dirty, 'last change');
    ada.send('session:leave', { choice: 'close' });
    await waitFor(() => bob.leftCode !== null, 'closed');
    await sleep(500);

    const notOwner = await connect('Bob', KEY, 'create').then(() => null, (e) => e);
    check('only the owner can open a closed saved session again', () => {
        assert.equal(notOwner?.code, 403);
        assert.match(notOwner.message, /owner \(Ada\)/);
    });

    const ada2 = await connect('Ada', KEY, 'create');
    ada2.send('sync-request', { have: [] });
    await waitFor(() => ada2.got('object:add', (p) => p.id === 'chair'), 'reopened chair');

    check('the owner opens it again with the same link, as admin', () => {
        assert.equal(ada2.state.you.role, 'admin');
        assert.equal(ada2.state.sessionName, 'Lobby design');
        assert.equal(ada2.state.scene.saved, true);
    });

    check('the last state was saved when the session ended', () => {
        const chairNow = last(ada2, 'object:add', (p) => p.id === 'chair');
        assert.deepEqual(chairNow.transform.position, [3, 0, 0]);
        assert.ok(ada2.got('object:add', (p) => p.id === 'lamp'));
        assert.equal(ada2.state.scene.latest.name, 'Session end');
    });

    const bob2 = await connect('Bob', KEY);
    check('people who were in it come back with their role, no waiting', () => {
        assert.equal(bob2.state.you.status, 'approved');
        assert.equal(bob2.state.you.role, 'editor');
    });

    const zoe = await connect('Zoe', KEY);
    check('new people still wait for an admin', () => assert.equal(zoe.state.you.status, 'pending'));


    console.log('\nSaved sessions per person');

    async function savedSession(key) {

        const user = await connect('Ada', key, 'create', { sessionName: key });
        const file = await upload(user.state.you.ticket, fakeGlb(1024, key.length), 'box.glb');
        user.send('object:add', { id: 'box', name: 'box.glb', assetId: file.json.assetId });
        await waitFor(() => objectIn(user, 'box'), 'box');
        user.send('scene:save', { name: 'v1' });
        await waitFor(
            () => user.got('scene:saved') || user.got('action:denied', (d) => d.type === 'scene:save'),
            'save answered'
        );
        return user;
    }

    const second = await savedSession('versions-session-02');
    const third = await savedSession('versions-session-03');
    const fourth = await savedSession('versions-session-04');

    check('the owner can keep up to the limit of saved sessions', () => {
        assert.ok(second.got('scene:saved'));
        assert.ok(third.got('scene:saved'));
    });

    check('one more is refused with a clear reason', () => {
        assert.equal(fourth.got('scene:saved'), false);
        assert.match(last(fourth, 'action:denied', (d) => d.type === 'scene:save').reason, /limit is 3/);
    });


    console.log(`\nAll ${passed} version checks passed`);
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
