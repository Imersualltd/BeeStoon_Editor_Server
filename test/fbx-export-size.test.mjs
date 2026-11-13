/*
 * FBX export: the 500 MiB size gate (raised from 50 MB).
 * --------------------------------------------------
 * Starts the real server on a spare port and POSTs bodies of controlled
 * sizes to /export/fbx as an approved session admin, checking only where
 * the 413 "too large" boundary now sits - not a real assimp conversion
 * (not guaranteed available in every environment this runs in). A body
 * that passes the size gate but is not a real convertible GLB fails later,
 * in a clearly different way (400/415), which is enough to prove it got
 * past the size check.
 *
 *   node test/fbx-export-size.test.mjs
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
const LIMIT = 500 * MB; // 524,288,000 bytes

let passed = 0;

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function waitFor(fn, label, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (fn()) return;
        await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
}

async function connect(name, sessionKey) {
    const client = new Client(URL);
    const room = await client.create('session', {
        sessionKey,
        identity: { userId: name.toLowerCase(), name },
    });
    const user = { name, room, state: null };
    room.onMessage('session:state', (payload) => { user.state = payload; });
    await waitFor(() => user.state, `${name} gets session:state`);
    return user;
}

// A real glTF 2.0 GLB header (magic + version + total length), no chunks.
// Enough to get past the size gate; splitGlb() rejects it afterward for an
// unrelated reason (missing JSON chunk) - never 413.
function fakeGlbHeader(size) {
    const body = Buffer.alloc(size, 0x41);
    body.writeUInt32LE(0x46546C67, 0); // "glTF"
    body.writeUInt32LE(2, 4);
    body.writeUInt32LE(size, 8);
    return body;
}

async function exportFbx(ticket, body) {
    const res = await fetch(`${URL}/export/fbx?name=size-probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${ticket}` },
        body,
        duplex: 'half',
    });
    return { status: res.status, text: await res.text() };
}

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-fbx-size-'));

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
    stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

function stopServer() {
    if (server.exitCode !== null) return Promise.resolve();
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    return Promise.race([exited, sleep(5000)]);
}

async function main() {
    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);

    const ada = await connect('Ada', 'fbx-size-0001'); // session creator: admin
    const ticket = ada.state.you.ticket;

    console.log('\nFBX export size gate (50 MB -> 500 MiB)');

    const small = await exportFbx(ticket, fakeGlbHeader(MB));
    check('a small file (1 MB) passes the size gate', () => assert.notEqual(small.status, 413));

    const over50 = await exportFbx(ticket, fakeGlbHeader(60 * MB));
    check('a file over the OLD 50 MB limit now passes the size gate', () => assert.notEqual(over50.status, 413));

    const near500 = await exportFbx(ticket, fakeGlbHeader(LIMIT - MB));
    check('a file approaching 500 MiB (499 MB) passes the size gate', () => assert.notEqual(near500.status, 413));

    const atLimit = await exportFbx(ticket, fakeGlbHeader(LIMIT));
    check('a file at exactly the 500 MiB limit still passes the size gate', () => assert.notEqual(atLimit.status, 413));

    const over500 = await exportFbx(ticket, fakeGlbHeader(LIMIT + MB));
    check('a file over the 500 MiB limit is rejected with a clear 413', () => {
        assert.equal(over500.status, 413);
        assert.match(over500.text, /too big for FBX export \(max 500 MB\)/);
    });

    check('none of this needed a ticket other than a normal approved member\'s', () => assert.ok(ticket));

    ada.room.leave();

    console.log(`\nAll ${passed} FBX export size checks passed`);
}

main()
    .then(async () => {
        await stopServer();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('\nFAILED:', error);
        console.error('\n--- server log ---\n' + serverLog.slice(-4000));
        await stopServer();
        await rm(storageDir, { recursive: true, force: true }).catch(() => {});
        process.exit(1);
    });
