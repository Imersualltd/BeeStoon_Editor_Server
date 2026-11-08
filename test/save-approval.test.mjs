/*
 * Save Session by a non-admin waits for an admin: approve / decline,
 * the approved scene is the one asked for, one save however many
 * clicks or admins, no admin online said at once, admins save
 * directly, and an empty session says why it is not saved.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3900 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), 'beestoon-editor-save-approval-'));
const TINY_GLB = 'data:model/gltf-binary;base64,AAAA';

let passed = 0;
let server = null;
let serverLog = '';

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function waitFor(fn, label, timeout = 4000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (fn()) {
            return;
        }
        await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
}

async function startServer() {
    server = spawn(process.execPath, ['src/index.mjs'], {
        env: { ...process.env, PORT: String(PORT), AUTH_PROVIDER: 'dev', ALLOW_DEV_AUTH: 'true', MAIL_PROVIDER: 'log',
            SCENE_STORAGE: 'local', SCENE_LOCAL_DIR: STORAGE, AUTOSAVE_MINUTES: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${URL}/health`)).ok) {
                return;
            }
        } catch { /* starting */ }
        await sleep(100);
    }
    throw new Error('server did not start');
}

async function connect(name, sessionKey, mode = 'join') {
    const client = new Client(URL);
    const room = await client[mode]('session', { sessionKey, identity: { userId: name.toLowerCase(), name } });
    const user = { name, room, messages: [], state: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.send = (type, data = {}) => room.send(type, data);
    user.all = (type) => user.messages.filter((m) => m.type === type).map((m) => m.payload);
    user.last = (type) => user.all(type).at(-1);
    await waitFor(() => user.state, `${name} state`);
    return user;
}

// Saves by people (not the automatic one when a room ends)
const saves = () => (serverLog.match(/\] saved "(?!Session end)/g) || []).length;


async function main() {

    await startServer();
    const KEY = 'saveapproval1';
    const ada = await connect('Ada', KEY, 'create');
    const ben = await connect('Ben', KEY);
    const cy = await connect('Cy', KEY);
    ada.send('join:approve', { userId: ben.state.you.userId, role: 'editor' });
    ada.send('join:approve', { userId: cy.state.you.userId, role: 'admin' });
    await waitFor(() => ben.state.you.status === 'approved' && cy.state.you.role === 'admin', 'approved');

    console.log('\nAn empty session');
    ben.send('scene:save', { name: 'Nothing' });
    await waitFor(() => ben.all('action:denied').some((d) => d.type === 'scene:save'), 'empty refused');
    check('saving an empty session says why, not "Saving failed"', () => {
        assert.match(ben.last('action:denied').reason, /Nothing to save yet: add a model first/);
        assert.equal(saves(), 0);
    });

    console.log('\nA non-admin asks, an admin approves');
    ada.send('object:add', { id: 'obj-1', name: 'one.glb', dataUrl: TINY_GLB });
    await waitFor(() => ben.state.objects?.length === 1 || Object.keys(ben.state.objects || {}).length === 1, 'object');
    for (let i = 0; i < 3; i++) {
        ben.send('scene:save', { name: 'Ben version' });              // clicked three times
    }
    await waitFor(() => ada.all('save:request').length >= 1 && cy.all('save:request').length >= 1, 'admins asked');
    await sleep(200);
    const request = ada.last('save:request');
    check('every online admin is asked "[Name] wants to save this session. Allow?" once', () => {
        assert.equal(request.text, 'Ben wants to save this session. Allow?');
        assert.equal(ada.all('save:request').length, 1);
        assert.equal(cy.all('save:request').length, 1);
    });
    check('the requester sees pending (the same request for every click), nothing saved yet', () => {
        assert.ok(ben.all('save:status').every((s) => s.status === 'pending' && s.requestId === request.requestId));
        assert.equal(saves(), 0);
    });
    // Changed after asking: the approved save is the scene as asked
    ada.send('object:add', { id: 'obj-2', name: 'two.glb', dataUrl: TINY_GLB });
    await sleep(200);
    ada.send('save:approve', { requestId: request.requestId });
    cy.send('save:approve', { requestId: request.requestId });       // a second admin, at the same time
    ada.send('save:approve', { requestId: request.requestId });       // and a double click
    await waitFor(() => ben.all('save:status').some((s) => s.status === 'approved'), 'approved');
    await sleep(300);
    check('saved once, as Ben, after the approval', () => {
        assert.equal(saves(), 1);
        assert.match(serverLog, /saved "Ben version" \(1 models, [0-9.]+ MB\) by Ben/);
        assert.match(ben.all('save:status').find((s) => s.status === 'approved').text, /Ada approved your save/);
    });
    check('the approved version holds the scene as it was asked for (1 object, not 2); the rest stays unsaved', () => {
        assert.match(serverLog, /saved "Ben version" \(1 models/);
        assert.equal(ada.state.scene?.dirty, true);
    });
    check('the other admins\' popups close with the outcome; late answers only hear it', () => {
        assert.ok(cy.all('save:resolved').some((r) => r.requestId === request.requestId && r.status === 'approved'));
        assert.ok(ada.all('save:resolved').some((r) => r.status === 'approved'));
    });

    console.log('\nDecline');
    await sleep(3200);
    ben.send('scene:save', { name: 'Second try' });
    await waitFor(() => ada.all('save:request').length === 2, 'second request');
    const second = ada.last('save:request');
    cy.send('save:decline', { requestId: second.requestId });
    await waitFor(() => ben.all('save:status').some((s) => s.status === 'declined'), 'declined');
    ada.send('save:approve', { requestId: second.requestId });          // too late
    await waitFor(() => ada.all('save:resolved').some((r) => r.requestId === second.requestId && r.status === 'declined'), 'late');
    check('declined: nothing saved, the requester is told who declined, a late approval saves nothing', () => {
        assert.equal(saves(), 1);
        assert.match(ben.last('save:status').text, /Cy declined your save/);
    });

    console.log('\nNo admin online (the only admin\'s connection dropped)');
    await ada.room.leave();
    await cy.room.leave();
    await ben.room.leave();
    await sleep(300);
    const fay = await connect('Fay', 'saveapproval3', 'create');
    const gus = await connect('Gus', 'saveapproval3');
    fay.send('join:approve', { userId: gus.state.you.userId, role: 'editor' });
    await waitFor(() => gus.state.you.status === 'approved', 'gus in');
    fay.send('object:add', { id: 'obj-5', name: 'five.glb', dataUrl: TINY_GLB });
    await sleep(200);
    await fay.room.leave(false);                                       // dropped, may come back
    await sleep(300);
    gus.send('scene:save', { name: 'Alone' });
    await waitFor(() => gus.all('save:status').length, 'answer');
    check('with no admin to approve it, the save is refused at once with the reason (not silently saved)', () => {
        const s = gus.last('save:status');
        assert.equal(s?.status, 'no-admin');
        assert.match(s.text, /No session admin is online/);
        assert.equal(saves(), 1);
    });
    await gus.room.leave();

    console.log('\nAdmins save directly');
    const eve = await connect('Eve', 'saveapproval2', 'create');
    eve.send('object:add', { id: 'obj-9', name: 'nine.glb', dataUrl: TINY_GLB });
    await sleep(200);
    eve.send('scene:save', { name: 'Admin save' });
    await waitFor(() => /saved "Admin save"/.test(serverLog), 'admin save');
    check('an admin\'s Save is not a request', () => assert.equal(eve.all('save:status').length, 0));
    await eve.room.leave();

    console.log(`\nAll ${passed} checks passed`);
}


main()
    .then(() => { server.kill(); process.exit(0); })
    .catch((error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog.slice(-5000));
        server.kill();
        process.exit(1);
    });
