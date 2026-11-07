/*
 * Reconnecting: a server restart, an absence longer than the
 * reconnection window, reopening a saved session.
 *
 * Reproduced first against the deployed code (scratchpad
 * connect-repro.mjs, production settings):
 *  - after a restart (every Render deploy, a free instance
 *    spinning down) the first person back became admin of the
 *    re-created room and the owner waited for their approval;
 *  - when the only admin was away longer than the reconnection
 *    window (network gone, laptop asleep, a slow cold start), the
 *    session was closed and its link answered 410 for 24 hours:
 *    the owner saw "Session ended" and refreshing did not help.
 *
 * The server is started twice on the same storage to restart it.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 2900 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), 'beestoon-editor-reconnect-test-'));
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
        env: {
            ...process.env,
            PORT: String(PORT),
            AUTH_PROVIDER: 'dev',
            ALLOW_DEV_AUTH: 'true',
            ADMIN_GRACE_SECONDS: '30',
            RECONNECT_WINDOW: '1',
            MAIL_PROVIDER: 'log',
            SCENE_STORAGE: 'local',
            SCENE_LOCAL_DIR: STORAGE
        },
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

async function restartServer() {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
    await startServer();
}

async function connect(name, sessionKey, mode = 'join') {
    const client = new Client(URL);
    const room = await client[mode]('session', { sessionKey, identity: { userId: name.toLowerCase(), name } });
    const user = { name, room, messages: [], state: null, leftCode: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    room.onLeave((code) => { user.leftCode = code; });
    user.send = (type, data = {}) => room.send(type, data);
    await waitFor(() => user.state, `${name} gets session:state`);
    return user;
}

// What the editor does: join, and create again with the same key when the room is gone
async function open(name, sessionKey) {
    try {
        return await connect(name, sessionKey, 'join');
    } catch (error) {
        return connect(name, sessionKey, 'create');
    }
}

const you = (user) => user.state.you;
const userIn = (user, name) => user.state.users?.find((u) => u.name === name);


async function main() {

    await startServer();

    console.log('\nServer restart: the owner and approved members get their places back');
    const KEY = 'restart00001';
    const ada = await connect('Ada', KEY, 'create');
    const bob = await connect('Bob', KEY);
    const dan = await connect('Dan', KEY);
    const cal = await connect('Cal', KEY);
    ada.send('join:approve', { userId: you(bob).userId, role: 'editor' });
    ada.send('join:approve', { userId: you(dan).userId, role: 'viewer' });
    await waitFor(() => you(bob).status === 'approved' && you(dan).status === 'approved', 'bob and dan approved');
    ada.send('user:kick', { userId: you(dan).userId });
    await waitFor(() => dan.leftCode !== null, 'dan removed');
    await sleep(500);   // the record is written 300 ms after a change

    await restartServer();

    const bob2 = await open('Bob', KEY);                     // the first one back is a member
    check('a member who is back first gets their own role, not admin', () => {
        assert.equal(you(bob2).status, 'approved');
        assert.equal(you(bob2).role, 'editor');
    });
    const ada2 = await open('Ada', KEY);
    check('the owner is admin again, without waiting for anyone', () => {
        assert.equal(you(ada2).status, 'approved');
        assert.equal(you(ada2).role, 'admin');
        assert.equal(ada2.state.owner.name, 'Ada');
    });
    const dan2 = await open('Dan', KEY);
    check('someone removed before the restart still has to ask', () => {
        assert.equal(you(dan2).status, 'pending');
        assert.ok(ada2.messages.some((m) => m.type === 'join:request' && m.payload.userId === you(dan2).userId && m.payload.removedBefore));
    });
    const cal2 = await open('Cal', KEY);
    check('someone who was waiting waits again', () => assert.equal(you(cal2).status, 'pending'));
    ada2.send('join:approve', { userId: you(dan2).userId, role: 'viewer' });
    await waitFor(() => you(dan2).status === 'approved', 'dan approved again');
    check('the admin can let a removed person back in', () => assert.equal(you(dan2).role, 'viewer'));
    for (const u of [bob2, ada2, dan2, cal2]) {
        await u.room.leave();
    }
    await sleep(300);


    console.log('\nA restart right after an approval (a deploy stops the old instance)');
    const KEYQ = 'quickrestart';
    const adaQ = await connect('Ada', KEYQ, 'create');
    const bobQ = await connect('Bob', KEYQ);
    adaQ.send('join:approve', { userId: you(bobQ).userId, role: 'editor' });
    await waitFor(() => you(bobQ).status === 'approved', 'bob approved');
    await restartServer();                                   // no wait for the 300 ms write
    const bobQ2 = await open('Bob', KEYQ);
    check('the approval made just before the restart is kept', () => {
        assert.equal(you(bobQ2).status, 'approved');
        assert.equal(you(bobQ2).role, 'editor');
    });
    await bobQ2.room.leave();
    await sleep(300);


    console.log('\nThe only admin away longer than the reconnection window');
    const KEY2 = 'absence00001';
    const solo = await connect('Ada', KEY2, 'create');
    await solo.room.leave(false);                           // dropped, not left on purpose
    await sleep(2500);                                      // window (1 s) over: the room ends
    check('the session was not closed (log)', () => assert.ok(!/session closed by Ada[^\n]*\n[^\n]*absence00001/.test(serverLog)));
    const back = await open('Ada', KEY2);
    check('the owner opens the same link again and is admin (it used to answer 410 for 24 hours)', () => {
        assert.equal(you(back).role, 'admin');
        assert.equal(back.state.owner.name, 'Ada');
    });
    await back.room.leave();
    await sleep(300);


    console.log('\nA saved session: an approved member opens it while the owner is away');
    const KEY3 = 'savedmember1';
    const owner = await connect('Ada', KEY3, 'create');
    const member = await connect('Bob', KEY3);
    owner.send('join:approve', { userId: you(bob).userId, role: 'editor' });
    await waitFor(() => you(member).status === 'approved', 'bob approved');
    owner.send('object:add', { id: 'obj-1', name: 'cube.glb', dataUrl: TINY_GLB });
    await sleep(200);
    owner.send('scene:save', { name: 'First' });
    await waitFor(() => owner.messages.some((m) => m.type === 'scene:saved'), 'saved');
    await member.room.leave();
    await owner.room.leave();
    await sleep(500);
    const alone = await open('Bob', KEY3);
    check('the member is back in as editor (owner-only before)', () => {
        assert.equal(you(alone).status, 'approved');
        assert.equal(you(alone).role, 'editor');
    });
    check('the saved models come with it', () => assert.equal(alone.state.objects.length, 1));
    const stranger = await open('Zoe', KEY3);
    check('someone new waits for an admin', () => assert.equal(you(stranger).status, 'pending'));
    await alone.room.leave();
    await stranger.room.leave();
    await sleep(500);
    await restartServer();
    const afterRestart = await open('Bob', KEY3);
    check('also after a server restart', () => assert.equal(you(afterRestart).role, 'editor'));
    await afterRestart.room.leave();
    await sleep(300);


    console.log('\nClosed by an admin: closed for good, also after a restart');
    const KEY4 = 'closedbyadm1';
    const a4 = await connect('Ada', KEY4, 'create');
    const b4 = await connect('Bob', KEY4);
    a4.send('join:approve', { userId: you(b4).userId, role: 'editor' });
    await waitFor(() => you(b4).status === 'approved', 'bob approved');
    a4.send('session:close');
    await waitFor(() => a4.leftCode !== null && b4.leftCode !== null, 'closed');
    await sleep(500);
    await restartServer();
    const tryAgain = await open('Bob', KEY4).then(() => null, (e) => e);
    check('an unsaved session closed by its admin stays closed after a restart (410)', () => assert.equal(tryAgain?.code, 410));
    const tryOwner = await open('Ada', KEY4).then(() => null, (e) => e);
    check('for its owner too', () => assert.equal(tryOwner?.code, 410));


    console.log('\nStatus shows a restart, without user data');
    const status = await (await fetch(`${URL}/`)).json();
    check('start time and uptime', () => {
        assert.ok(Date.parse(status.startedAt) > Date.now() - 60000);
        assert.ok(Number.isInteger(status.uptimeSeconds));
        assert.ok(!JSON.stringify(status).includes('Ada'));
    });

    console.log(`\nAll ${passed} checks passed`);
}


main()
    .then(() => {
        server.kill();
        process.exit(0);
    })
    .catch((error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog.slice(-6000));
        server.kill();
        process.exit(1);
    });
