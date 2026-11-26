/*
 * VR review test
 * --------------------------------------------------
 * An editor's VR changes all go to the admins; the
 * editor confirms the rows assigned to them first, the
 * admin has the last word.
 *
 *   node test/vr-review.test.mjs
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

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-vr-review-test-'));

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

    const KEY = 'vr-review-0001';

    const ada = await connect('Ada', KEY, 'create');
    const bob = await connect('Bob', KEY);

    await approve(ada, bob, 'editor');


    console.log('\nAn editor\'s VR changes go to the admin, all of them');

    const changes = [
        { key: 'c0', objectId: 'sofa', name: 'sofa.glb', moved: true, rotated: true, mine: true },
        { key: 'c1', objectId: 'lamp', name: 'lamp.glb', deleted: true },
        { key: 'c2', objectId: 'rug', name: 'rug.glb' }            // nothing changed: dropped
    ];
    const ops = [
        { key: 'o0', tool: 'slicer', name: 'table.glb', pieces: 2, mine: true },
        { key: 'o1', tool: 'sculpt', name: 'vase.glb', pieces: 1, after: ['o0'] },
        { key: 'o2', tool: 'evil<script>', name: 'x'.repeat(500) }
    ];

    bob.send('vr:review', { changes, ops });

    await waitFor(() => ada.got('vr:review-request'), 'admin gets the list');
    const request = last(ada, 'vr:review-request');

    check('the admin gets every row, with the ones assigned to the editor marked', () => {
        assert.equal(request.by.name, 'Bob');
        assert.deepEqual(request.changes.map((c) => [c.key, c.mine]), [['c0', true], ['c1', false]]);
        assert.deepEqual(request.ops.map((o) => [o.key, o.tool, o.mine]), [['o0', 'slicer', true], ['o1', 'sculpt', false], ['o2', 'other', false]]);
        assert.equal(request.ops[2].name.length, 200);
        assert.deepEqual(request.ops[1].after, ['o0']);
    });

    await waitFor(() => bob.got('vr:review-status', (s) => s.status === 'pending'), 'bob waits');
    check('the editor hears that an admin will confirm', () => {
        assert.equal(last(bob, 'vr:review-status').requestId, request.requestId);
        assert.equal(last(bob, 'vr:review-status').waiting, false);
    });


    console.log('\nThe editor confirms their own rows; the admin sees it');

    const before = ada.messages.filter((m) => m.type === 'vr:review-request').length;

    bob.send('vr:review-update', { requestId: request.requestId, keep: {
        changes: { c0: { moved: true, rotated: false }, c1: { deleted: true } },
        ops: { o0: true, o1: true }
    } });

    await waitFor(() => ada.messages.filter((m) => m.type === 'vr:review-request').length > before, 'update reaches admin');
    const updated = last(ada, 'vr:review-request');

    check('only rows assigned to the editor take the editor\'s answer', () => {
        assert.deepEqual(updated.changes[0].userKeep, { moved: true, rotated: false, scaled: false, deleted: false });
        assert.equal(updated.changes[1].userKeep, null);
        assert.equal(updated.ops[0].userKeep, true);
        assert.equal(updated.ops[1].userKeep, null);
    });


    console.log('\nOnly an admin answers, and the admin has the last word');

    bob.send('vr:review-answer', { requestId: request.requestId, keep: {} });
    await waitFor(() => bob.got('action:denied', (d) => d.type === 'vr:review-answer'), 'editor cannot answer');
    check('an editor cannot answer', () => {});

    ada.send('vr:review-answer', { requestId: request.requestId, keep: {
        changes: { c0: { moved: false }, c1: { deleted: true }, zz: { moved: true } },
        ops: { o0: false, o1: true, o2: 'yes' }
    } });

    await waitFor(() => bob.got('vr:review-result'), 'bob gets the answer');
    const result = last(bob, 'vr:review-result');

    check('the editor gets the admin\'s answer, overriding their own', () => {
        assert.equal(result.by.name, 'Ada');
        assert.deepEqual(result.keep.changes, {
            c0: { moved: false, rotated: false, scaled: false, deleted: false },
            c1: { moved: false, rotated: false, scaled: false, deleted: true }
        });
        assert.deepEqual(result.keep.ops, { o0: false, o1: true, o2: false });
    });

    await waitFor(() => ada.got('vr:review-resolved', (r) => r.requestId === request.requestId), 'resolved');

    ada.send('vr:review-answer', { requestId: request.requestId, keep: {} });
    await waitFor(() => ada.messages.filter((m) => m.type === 'vr:review-resolved').length >= 2, 'second answer');
    check('a second answer only hears the result', () => {
        assert.equal(bob.messages.filter((m) => m.type === 'vr:review-result').length, 1);
    });


    console.log('\nAdmins answer their own; no admin yet; the requester leaving');

    ada.send('vr:review', { changes: [{ key: 'a', name: 'x', moved: true }] });
    await waitFor(() => ada.got('vr:review-status', (s) => s.status === 'failed'), 'admin refused');
    check('an admin confirms their own VR changes', () => {});

    // An admin who comes later still gets the request
    const cara = await connect('Cara', KEY);
    await approve(ada, cara, 'editor');
    cara.send('vr:review', { changes: [{ key: 'k', name: 'chair', scaled: true }] });
    await waitFor(() => ada.messages.filter((m) => m.type === 'vr:review-request' && m.payload.by.name === 'Cara').length, 'ada gets cara');
    ada.send('role:set', { userId: 'dev:bob', role: 'admin' });
    await waitFor(() => bob.got('vr:review-request', (r) => r.by.name === 'Cara'), 'new admin gets it');
    check('someone made admin gets the open requests', () => {});

    cara.room.leave();
    await waitFor(() => ada.got('vr:review-resolved', (r) => r.status === 'left'), 'cara left');
    check('the request closes when the requester leaves', () => {});

    ada.room.leave();
    bob.room.leave();

    console.log(`\nAll ${passed} VR review checks passed`);
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
