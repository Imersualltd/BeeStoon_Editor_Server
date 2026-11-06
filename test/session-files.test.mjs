/*
 * Session files from bucket storage test
 * --------------------------------------------------
 * Starts the server with S3 storage pointed at a small
 * in-memory bucket in this process, then checks what a
 * browser needs to load a session's files:
 *
 *   - ?link=1 hands members the signed bucket link as
 *     JSON (a browser following the old redirect sends
 *     "Origin: null", which a bucket CORS rule for the
 *     site refuses); others get 401
 *   - a saved session re-opens with links to this server,
 *     also when it was saved under another address
 *   - files gone from storage are reported (by name and
 *     why) to everyone who joins; the objects stay
 *
 *   node test/session-files.test.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3500 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;

const BUCKET_PORT = PORT + 400;
const BUCKET = 'editor-files';
const PREFIX = 'editor-scenes/';


// ==================================================
// IN-MEMORY BUCKET (path-style, signatures ignored)
// ==================================================

const objects = new Map();   // key -> Buffer

const bucket = http.createServer((req, res) => {

    const url = new globalThis.URL(req.url, 'http://bucket');
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const key = path.startsWith(`${BUCKET}/`) ? path.slice(BUCKET.length + 1) : '';

    const chunks = [];

    req.on('data', (c) => chunks.push(c));

    req.on('end', () => {

        if (req.method === 'PUT') {
            objects.set(key, Buffer.concat(chunks));
            res.writeHead(200, { ETag: '"x"' }).end();
            return;
        }

        if (req.method === 'DELETE') {
            objects.delete(key);
            res.writeHead(204).end();
            return;
        }

        if (!key) {
            const prefix = url.searchParams.get('prefix') || '';
            const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
            const body = `<?xml version="1.0"?><ListBucketResult><Name>${BUCKET}</Name>` +
                `<KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>` +
                keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('') +
                '</ListBucketResult>';
            res.writeHead(200, { 'Content-Type': 'application/xml' }).end(body);
            return;
        }

        const body = objects.get(key);

        if (!body) {
            res.writeHead(404, { 'Content-Type': 'application/xml' })
                .end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
            return;
        }

        res.writeHead(200, { 'Content-Length': String(body.length) });
        res.end(req.method === 'HEAD' ? undefined : body);
    });
});

await new Promise((resolve) => bucket.listen(BUCKET_PORT, '127.0.0.1', resolve));


// ==================================================
// HELPERS
// ==================================================

let passed = 0;

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

    assert.equal(res.status, 200, await res.clone().text());

    return res.json();
}


const last = (user, type, pred = () => true) =>
    [...user.messages].reverse().find((m) => m.type === type && pred(m.payload))?.payload;

const pathOf = (url) => new globalThis.URL(url).pathname;

const linkOf = (user, path, ticket = user.state.you.ticket) =>
    fetch(`${URL}${path}?link=1`, ticket ? { headers: { Authorization: `Bearer ${ticket}` } } : {});


// ==================================================
// SERVER
// ==================================================

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'dev',
        ALLOW_DEV_AUTH: 'true',
        MAIL_PROVIDER: 'log',
        AR_STORAGE: 'local',
        SCENE_STORAGE: 's3',
        S3_ENDPOINT: `http://127.0.0.1:${BUCKET_PORT}`,
        S3_REGION: 'us-east-1',
        S3_BUCKET: BUCKET,
        S3_ACCESS_KEY_ID: 'test',
        S3_SECRET_ACCESS_KEY: 'test',
        SCENE_S3_PREFIX: PREFIX,
        PUBLIC_BASE_URL: URL,
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


    console.log('\nLoading a file from the bucket');

    const KEY = 'session-files-01';

    const ada = await connect('Ada', KEY, 'create', { sessionName: 'Files' });
    const bob = await connect('Bob', KEY);

    ada.send('join:approve', { userId: 'dev:bob', role: 'editor' });
    await waitFor(() => bob.state.you.status === 'approved', 'Bob approved');

    const chairBytes = fakeGlb(2048, 1);
    const lampBytes = fakeGlb(1024, 2);

    const chair = await upload(ada.state.you.ticket, chairBytes, 'chair.glb');
    const lamp = await upload(ada.state.you.ticket, lampBytes, 'lamp.glb');

    ada.send('object:add', { id: 'chair', name: 'chair.glb', assetId: chair.assetId });
    ada.send('object:add', { id: 'lamp', name: 'lamp.glb', assetId: lamp.assetId });
    await waitFor(() => bob.got('object:add', (o) => o.id === 'lamp'), 'Bob gets both');

    const chairPath = pathOf(last(bob, 'object:add', (o) => o.id === 'chair').url);

    const linked = await linkOf(bob, chairPath);
    const link = await linked.json();

    check('?link=1 gives a member the signed bucket link as JSON', () => {
        assert.equal(linked.status, 200);
        assert.equal(linked.headers.get('cache-control'), 'no-store');
        assert.ok(link.url.startsWith(`http://127.0.0.1:${BUCKET_PORT}/${BUCKET}/${PREFIX}`), link.url);
        assert.match(link.url, /X-Amz-Signature=/);
        assert.equal(link.expiresIn, 3600);
    });

    const fromBucket = Buffer.from(await (await fetch(link.url)).arrayBuffer());
    check('and that link brings the file itself', () => assert.ok(fromBucket.equals(chairBytes)));

    const anonymous = await linkOf(bob, chairPath, null);
    check('nobody else gets a link (401)', () => assert.equal(anonymous.status, 401));

    const redirected = await fetch(`${URL}${chairPath}`, {
        headers: { Authorization: `Bearer ${bob.state.you.ticket}` },
        redirect: 'manual'
    });
    check('without ?link=1 the redirect stays for older editors', () => {
        assert.equal(redirected.status, 302);
        assert.match(redirected.headers.get('location'), /X-Amz-Signature=/);
    });


    console.log('\nSaving and re-opening');

    bob.send('object:transform', { id: 'chair', position: [4, 0, 1], rotation: [0, 0, 0], scale: [2, 2, 2] });
    await waitFor(() => last(ada, 'object:transform', (t) => t.id === 'chair'), 'move reaches Ada');

    ada.send('scene:save', { name: 'Two models' });
    await waitFor(() => ada.got('scene:saved'), 'saved');

    const sceneId = chairPath.split('/')[2];
    const versionKey = [...objects.keys()].find((k) => k.startsWith(`${PREFIX}${sceneId}/versions/`));

    check('the saved version names its files by id, stored in the bucket', () => {
        const version = JSON.parse(objects.get(versionKey));
        assert.deepEqual(version.objects.map((o) => o.assetId).sort(), [chair.assetId, lamp.assetId].sort());
        assert.ok(objects.has(`${PREFIX}${sceneId}/blobs/${chair.assetId}.glb`));
    });

    // An older record: saved under another address, and the
    // lamp's file has since gone from storage
    const version = JSON.parse(objects.get(versionKey));
    for (const o of version.objects) {
        o.url = `https://be-water-multiplayer.onrender.com/assets/${sceneId}/${o.assetId}.glb`;
    }
    objects.set(versionKey, Buffer.from(JSON.stringify(version)));
    objects.delete(`${PREFIX}${sceneId}/blobs/${lamp.assetId}.glb`);

    ada.send('session:leave', { choice: 'close' });
    await waitFor(() => bob.leftCode !== null, 'closed');
    await sleep(500);

    const ada2 = await connect('Ada', KEY, 'create');
    ada2.send('sync-request', { have: [] });
    await waitFor(() => ada2.got('object:add', (o) => o.id === 'lamp'), 'reopened');

    const chairAgain = last(ada2, 'object:add', (o) => o.id === 'chair');

    check('the re-opened scene has its models where they were', () => {
        assert.deepEqual(chairAgain.transform.position, [4, 0, 1]);
        assert.deepEqual(chairAgain.transform.scale, [2, 2, 2]);
        assert.ok(ada2.got('object:add', (o) => o.id === 'lamp'));
    });

    check('links point at this server, not the address it was saved under', () => {
        assert.ok(chairAgain.url.startsWith(`${URL}/assets/${sceneId}/`), chairAgain.url);
    });

    const chairLink = await linkOf(ada2, pathOf(chairAgain.url));
    check('and a fresh signed link loads the file', () => assert.equal(chairLink.status, 200));
    const reopenedBytes = Buffer.from(await (await fetch((await chairLink.json()).url)).arrayBuffer());
    check('with the same bytes as before', () => assert.ok(reopenedBytes.equals(chairBytes)));

    const lampLink = await linkOf(ada2, pathOf(last(ada2, 'object:add', (o) => o.id === 'lamp').url));
    const lampAnswer = await lampLink.json();
    check('a file gone from storage answers 404 "missing", not a broken link', () => {
        assert.equal(lampLink.status, 404);
        assert.equal(lampAnswer.code, 'missing');
    });

    check('whoever opens the session is told which file is missing and why', () => {
        const notice = last(ada2, 'session:notice', (n) => n.kind === 'error');
        assert.ok(notice, 'no notice');
        assert.deepEqual(notice.missingFiles.map((f) => f.name), ['lamp.glb']);
        assert.match(notice.text, /lamp\.glb \(its file is no longer in the session storage\)/);
        assert.match(notice.text, /saved session itself is kept/);
    });

    const bob2 = await connect('Bob', KEY);
    check('people coming back are told too', () => {
        assert.equal(bob2.state.you.status, 'approved');
        assert.ok(bob2.got('session:notice', (n) => n.missingFiles?.[0]?.name === 'lamp.glb'));
    });

    ada2.send('scene:save', { name: 'After reopening' });
    await waitFor(() => ada2.got('scene:saved'), 'saved again');

    const versions = [...objects.keys()].filter((k) => k.startsWith(`${PREFIX}${sceneId}/versions/`));
    const newest = versions.map((k) => JSON.parse(objects.get(k))).find((v) => v.name === 'After reopening');
    check('saving again keeps the missing model in the record', () => {
        assert.deepEqual(newest.objects.map((o) => o.id).sort(), ['chair', 'lamp']);
    });


    console.log(`\nAll ${passed} session file checks passed`);
}


main()
    .then(async () => {
        await stopServer();
        bucket.close();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog);
        await stopServer();
        bucket.close();
        process.exit(1);
    });
