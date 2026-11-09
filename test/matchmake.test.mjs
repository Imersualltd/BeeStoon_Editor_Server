/*
 * Join / create answers that get through Render's proxy, and a
 * saved session whose storage cannot be read.
 *
 * Production (curl -i -X POST https://beestoon-editor.onrender.com/
 * matchmake/join/nosuchroom): Cloudflare replaced the 520 answer
 * with "error code: 520" as plain text, without CORS. Reopening a
 * saved session starts with join; its 521 "no room" never reached
 * the editor, which never created the room: stuck on Connecting.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3600 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), 'beestoon-editor-matchmake-test-'));

let passed = 0;
let server = null;
let serverLog = '';

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function startServer() {
    server = spawn(process.execPath, ['src/index.mjs'], {
        env: {
            ...process.env,
            PORT: String(PORT),
            AUTH_PROVIDER: 'dev',
            ALLOW_DEV_AUTH: 'true',
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

const matchmake = (method, room, body) => fetch(`${URL}/matchmake/${method}/${room}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://beestoon.ai' },
    body: JSON.stringify(body)
});


async function main() {

    await startServer();
    const identity = { userId: 'ada', name: 'Ada' };

    console.log('\nNo 52x answers (the proxy would replace them)');
    const noRoom = await matchmake('join', 'session', { sessionKey: 'notopenyet001', identity });
    check('join of a session that is not open: 404 with a JSON reason (was 521)', () => {
        assert.equal(noRoom.status, 404);
        assert.match(noRoom.headers.get('content-type'), /json/);
    });
    const noType = await matchmake('join', 'nosuchroom', { identity });
    check('unknown room type: 501 (was 520)', () => assert.equal(noType.status, 501));
    check('every answer status is outside 520-527', () => {
        for (const r of [noRoom, noType]) {
            assert.ok(r.status < 520 || r.status > 527);
        }
    });

    console.log('\nThe editor\'s reopen (join, then create) still works');
    const client = new Client(URL);
    const joinError = await client.join('session', { sessionKey: 'notopenyet001', identity }).then(() => null, (e) => e);
    check('the SDK reports the join refusal as code 404', () => assert.equal(joinError?.code, 404));
    const room = await client.create('session', { sessionKey: 'notopenyet001', identity });
    check('create after it opens the session', () => assert.ok(room.roomId));
    await room.leave();

    console.log('\nA saved session whose storage cannot be read');
    mkdirSync(path.join(STORAGE, 'keys', 'brokenstore01.json'), { recursive: true });   // read -> EISDIR
    const broken = await new Client(URL).create('session', { sessionKey: 'brokenstore01', identity }).then(() => null, (e) => e);
    check('refused with 503 and the reason, not opened as a new empty session', () => {
        assert.equal(broken?.code, 503);
        assert.match(broken.message, /saved session could not be read/);
    });
    check('logged on the server', () => assert.match(serverLog, /could not read the saved session of brokenstore01/));
    const again = await new Client(URL).create('session', { sessionKey: 'brokenstore01', identity }).then(() => null, (e) => e);
    check('the key is not left taken: the next try is refused for the same reason (not 409)', () => assert.equal(again?.code, 503));

    console.log(`\nAll ${passed} checks passed`);
}


main()
    .then(() => { server.kill(); process.exit(0); })
    .catch((error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog.slice(-4000));
        server.kill();
        process.exit(1);
    });
