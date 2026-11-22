/*
 * Error tracking (instrument.mjs)
 * --------------------------------------------------
 * The scrubbing rules, then the real server started the
 * way Render starts it (node --import ./src/instrument.mjs)
 * with a fake Sentry: requests carrying a session key in
 * the path, a token in the query and an address header
 * reach it as traces with none of those in them.
 *
 *   node test/error-tracking.test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { NO_ADDRESS, scrub, scrubEvent, scrubText, sentryEnvironment, traceRate } from '../src/instrument.mjs';


// --- the rules -------------------------------------------------------------

const KEY = 'k3yAbcdEfghIjklMnopQrstUvwxYz01';   // 30 chars like a real session key

assert.equal(scrubText(`could not read the saved session of ${KEY}: timeout`),
    'could not read the saved session of [Filtered]: timeout');
assert.equal(scrubText(`DELETE /sessions/${KEY}`), 'DELETE /sessions/[Filtered]');
assert.equal(scrubText(`/internal/sessions/${KEY}/members/u1`), '/internal/sessions/[Filtered]/members/u1');
assert.equal(scrubText('/assets/sceneAbcdefghij0123456789/a.glb'), '/assets/[Filtered]/a.glb');
assert.equal(scrubText('/ar/abcdefghij/model.glb'), '/ar/[Filtered]/model.glb');
assert.equal(scrubText('GET /sessions/mine'), 'GET /sessions/mine');
assert.equal(scrubText('POST /ar/snapshots'), 'POST /ar/snapshots');
assert.equal(scrubText('/ar/:id/model.glb'), '/ar/:id/model.glb');   // route patterns stay
assert.equal(scrubText('/editor?session=abc&x=1'), '/editor?[Filtered]');
assert.equal(scrubText('invite for ada@x.example failed'), 'invite for [Filtered] failed');
// Ordinary words and names stay readable
assert.equal(scrubText('installProxySafeMatchmaking failed: ERR_INVALID_ARG_TYPE'),
    'installProxySafeMatchmaking failed: ERR_INVALID_ARG_TYPE');

const event = scrubEvent({
    user: { id: 'jwt:abc', ip_address: '81.2.69.142' },
    request: { url: `https://x/sessions/${KEY}?t=1`, query_string: 't=1', cookies: { a: '1' }, data: '{}' },
    exception: { values: [{ value: `room ${KEY} broke`,
        stacktrace: { frames: [{ filename: '/app/src/BeeStoon_Editor_Server2/ModelRoom.mjs' }] } }] }
});
assert.deepEqual(event.user, NO_ADDRESS);
assert.deepEqual(event.request, { url: 'https://x/sessions/[Filtered]?[Filtered]' });
assert.equal(event.exception.values[0].value, 'room [Filtered] broke');
// File names in the stack trace are left alone
assert.equal(event.exception.values[0].stacktrace.frames[0].filename, '/app/src/BeeStoon_Editor_Server2/ModelRoom.mjs');
assert.deepEqual(scrub({ n: 3, b: true, z: null }), { n: 3, b: true, z: null });
// Sentry's own ids look like tokens but are kept (Sentry refuses an event without them)
const ids = scrubEvent({ event_id: '4f10782c6b3a4fa881e3a5422a7983a6',
    contexts: { trace: { trace_id: '7b67f14c7a9946f2bcc508a50a47c8d9', span_id: 'a1b2c3d4e5f60718' } } });
assert.equal(ids.event_id, '4f10782c6b3a4fa881e3a5422a7983a6');
assert.equal(ids.contexts.trace.trace_id, '7b67f14c7a9946f2bcc508a50a47c8d9');
assert.equal(ids.contexts.trace.span_id, 'a1b2c3d4e5f60718');

assert.equal(sentryEnvironment({ NODE_ENV: 'production' }), 'production');
assert.equal(sentryEnvironment({ NODE_ENV: 'production', EDITOR_DEPLOYMENT: 'development' }), 'development');
assert.equal(sentryEnvironment({ SENTRY_ENVIRONMENT: 'staging' }), 'staging');
assert.equal(traceRate({ NODE_ENV: 'production' }), 0.1);
assert.equal(traceRate({}), 1);
assert.equal(traceRate({ SENTRY_TRACES_SAMPLE_RATE: '5' }), 1);
console.log('ok - scrubbing rules');


// --- the real server with a fake Sentry --------------------------------------

const PORT = 4300 + Math.floor(Math.random() * 300);
const SENTRY_PORT = PORT + 400;
const URL = `http://localhost:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), 'beestoon-editor-sentry-'));

const received = [];
const sentry = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
        received.push(body.toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
});
await new Promise((resolve) => sentry.listen(SENTRY_PORT, resolve));

let serverLog = '';
const server = spawn(process.execPath, ['--import', './src/instrument.mjs', 'src/index.mjs'], {
    env: {
        ...process.env, PORT: String(PORT), AUTH_PROVIDER: 'dev', ALLOW_DEV_AUTH: 'true', MAIL_PROVIDER: 'log',
        SCENE_STORAGE: 'local', SCENE_LOCAL_DIR: STORAGE, AUTOSAVE_MINUTES: '0',
        SENTRY_DSN: `http://publickey@localhost:${SENTRY_PORT}/1`, SENTRY_ENVIRONMENT: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
        try { up = (await fetch(`${URL}/health`)).ok; } catch { /* starting */ }
        if (!up) await sleep(100);
    }
    assert.ok(up, `server did not start with Sentry on:\n${serverLog}`);

    const headers = { 'X-Forwarded-For': '81.2.69.142', 'X-Identity': '{"name":"Ada","email":"ada@x.example"}' };
    await fetch(`${URL}/sessions/${KEY}?token=SECRET-TOKEN`, { method: 'DELETE', headers });
    await fetch(`${URL}/internal/sessions/${KEY}/members/u1`, { headers });
    await fetch(`${URL}/ar/abcdefghijklmnopqrstuvwxyz0123`, { headers });

    // Spans are sent in batches: wait until some arrive
    for (let i = 0; i < 100 && !received.join('').includes('"span"'); i++) await sleep(100);
    const text = received.join('\n');
    assert.ok(text.includes('"span"'), `no traces reached the fake Sentry:\n${serverLog}`);
    for (const secret of [KEY, 'SECRET-TOKEN', '81.2.69.142', 'ada@x.example', 'abcdefghijklmnopqrstuvwxyz0123']) {
        assert.ok(!text.includes(secret), `"${secret}" reached Sentry`);
    }
    console.log('ok - the server starts with Sentry and its traces keep secrets out');
} finally {
    server.kill();
    sentry.close();
}
