/*
 * AR share link test
 * --------------------------------------------------
 * Starts the server on a spare port with local AR
 * storage in a temp folder and links that expire after
 * about 2 seconds, then uploads a snapshot as a
 * session admin and opens the link.
 *
 *   node test/ar-share.test.mjs   (also part of npm test)
 *
 * Exits with code 1 on the first failed check.
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

let passed = 0;

function check(label, fn) {

    fn();
    passed++;
    console.log(`  ok  ${label}`);
}


async function waitFor(fn, label, timeout = 3000) {

    const end = Date.now() + timeout;

    while (Date.now() < end) {

        if (await fn()) {
            return;
        }

        await sleep(25);
    }

    throw new Error(`Timed out: ${label}`);
}


// Smallest file the server accepts: GLB header + padding
function fakeGlb() {

    const glb = Buffer.alloc(64, 7);

    glb.writeUInt32LE(0x46546C67, 0);   // "glTF"
    glb.writeUInt32LE(2, 4);            // version 2
    glb.writeUInt32LE(64, 8);           // length

    return glb;
}


async function upload(body, ticket) {

    const headers = { 'Content-Type': 'application/octet-stream' };

    if (ticket) {
        headers.Authorization = `Bearer ${ticket}`;
    }

    return fetch(`${URL}/ar/snapshots?name=Living%20room.glb`, { method: 'POST', headers, body });
}


// ==================================================
// SERVER
// ==================================================

const storeDir = await mkdtemp(path.join(tmpdir(), 'be-water-ar-test-'));

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'dev',
        ALLOW_DEV_AUTH: 'true',
        AR_STORAGE: 'local',
        AR_LOCAL_DIR: storeDir,
        SCENE_STORAGE: 'local',
        SCENE_LOCAL_DIR: path.join(storeDir, 'scenes'),
        // about 2 seconds
        AR_LINK_HOURS: String(2 / 3600)
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';

server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));


async function main() {

    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);


    console.log('\nAR share links');

    const client = new Client(URL);

    const room = await client.create('session', {
        sessionKey: 'ar-test-session-01',
        identity: { userId: 'ada', name: 'Ada' }
    });

    let state = null;
    room.onMessage('*', (type, payload) => {
        if (type === 'session:state') {
            state = payload;
        }
    });

    await waitFor(() => state?.you?.ticket, 'admin ticket');
    const ticket = state.you.ticket;


    const noTicket = await upload(fakeGlb());
    check('upload without a ticket is refused (401)', () => assert.equal(noTicket.status, 401));

    const notGlb = await upload(Buffer.from('hello, this is not a model'), ticket);
    check('a file that is not a GLB is refused (415)', () => assert.equal(notGlb.status, 415));


    const res = await upload(fakeGlb(), ticket);
    const reply = await res.json();

    check('a session member gets a link', () => {
        assert.equal(res.status, 200);
        assert.match(reply.url, new RegExp(`^http://localhost:${PORT}/ar/[A-Za-z0-9_-]{30}$`));
        assert.ok(Date.parse(reply.expiresAt) > Date.now());
    });


    const page = await fetch(reply.url);
    const html = await page.text();

    check('the link opens the viewer page without login', () => {
        assert.equal(page.status, 200);
        assert.ok(html.includes('<model-viewer'));
        assert.ok(html.includes('ar-scale="fixed"'));
        assert.ok(html.includes('Living room'));
    });


    const model = await fetch(`${reply.url}/model.glb`);
    const bytes = Buffer.from(await model.arrayBuffer());

    check('the model downloads unchanged', () => {
        assert.equal(model.status, 200);
        assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
        assert.ok(bytes.equals(fakeGlb()));
    });


    const unknown = await fetch(`${URL}/ar/${'x'.repeat(30)}`);
    check('an unknown link shows the expired page (410)', () => assert.equal(unknown.status, 410));


    await sleep(2500);

    const expired = await fetch(reply.url);
    const expiredModel = await fetch(`${reply.url}/model.glb`);

    check('after it expires the link and model are gone (410)', () => {
        assert.equal(expired.status, 410);
        assert.equal(expiredModel.status, 410);
    });


    await room.leave();

    console.log(`\nAll ${passed} AR checks passed`);
}


main()
    .then(async () => {
        server.kill();
        await rm(storeDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog);
        server.kill();
        await rm(storeDir, { recursive: true, force: true });
        process.exit(1);
    });
