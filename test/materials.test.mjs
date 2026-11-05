/*
 * Material and texture edits test
 * --------------------------------------------------
 * object:material is shared with the session, follows the
 * same edit rights and holds as moving a model, is saved
 * with versions, comes back after a restore and when the
 * owner reopens the session, and never changes the GLB.
 * Texture images: upload (members with edit rights, images
 * only, counted in the session total) and download
 * (members only).
 *
 *   node test/materials.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';

import { cleanMaterialPatch, mergeMaterial } from '../src/materials.mjs';


const PORT = 3600 + Math.floor(Math.random() * 300);
const SERVER = `http://localhost:${PORT}`;
const KEY = 'materials-session-01';

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

async function connect(name, mode = 'join', extra = {}) {
    const client = new Client(SERVER);
    const room = await client[mode]('session', { sessionKey: KEY, identity: { userId: name.toLowerCase(), name }, ...extra });
    const user = { name, room, messages: [], state: null, leftCode: null };
    room.onLeave((code) => { user.leftCode = code; });
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.got = (type, pred = () => true) => user.messages.some((m) => m.type === type && pred(m.payload));
    user.count = (type, pred = () => true) => user.messages.filter((m) => m.type === type && pred(m.payload)).length;
    user.last = (type, pred = () => true) => [...user.messages].reverse().find((m) => m.type === type && pred(m.payload))?.payload;
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

// A real 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function post(pathname, ticket, body) {
    const res = await fetch(`${SERVER}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...(ticket ? { Authorization: `Bearer ${ticket}` } : {}) },
        body
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, json, text };
}

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-materials-test-'));

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'dev',
        ALLOW_DEV_AUTH: 'true',
        CREDITS_ENABLED: 'false',
        AUTOSAVE_MINUTES: '0',
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

    console.log('\nRules');

    check('patches are validated: colors, 0..1 values, known slots, uploaded textures only', () => {
        const uploaded = new Set(['a'.repeat(64)]);
        assert.deepEqual(cleanMaterialPatch({ color: '#FF0000', metalness: 0.25 }, uploaded), { color: '#ff0000', metalness: 0.25 });
        assert.equal(cleanMaterialPatch({ color: 'red' }, uploaded), null);
        assert.equal(cleanMaterialPatch({ roughness: 2 }, uploaded), null);
        assert.equal(cleanMaterialPatch({ maps: { emissive: null } }, uploaded), null);
        assert.equal(cleanMaterialPatch({ maps: { base: 'b'.repeat(64) } }, uploaded), null);
        assert.deepEqual(cleanMaterialPatch({ maps: { base: 'a'.repeat(64), normal: null } }, uploaded),
            { maps: { base: 'a'.repeat(64), normal: null } });
        assert.equal(mergeMaterial({}, 64, {}), null);
        assert.deepEqual(mergeMaterial({ 0: { color: '#000000', maps: { base: null } } }, 0, { maps: { normal: null } }),
            { 0: { color: '#000000', maps: { base: null, normal: null } } });
    });

    console.log('\nSharing edits');

    const ada = await connect('Ada', 'create', { sessionName: 'Materials' });
    const bob = await connect('Bob');
    const cat = await connect('Cat');
    const vic = await connect('Vic');
    ada.send('join:approve', { userId: 'dev:bob', role: 'editor' });
    ada.send('join:approve', { userId: 'dev:cat', role: 'editor' });
    ada.send('join:approve', { userId: 'dev:vic', role: 'viewer' });
    await waitFor(() => bob.state.you.ticket && cat.state.you.ticket && vic.state.you.ticket, 'approved');
    check('the server announces material sync', () => assert.equal(ada.state.features.materials, true));

    const glb = fakeGlb(4096, 7);
    const up = await post('/assets?name=chair.glb', bob.state.you.ticket, glb);
    bob.send('object:add', { id: 'chair', name: 'chair.glb', assetId: up.json.assetId });
    await waitFor(() => ada.got('object:add', (p) => p.id === 'chair'), 'chair shared');

    ada.send('object:material', { id: 'chair', index: 0, patch: { color: '#ff0000', metalness: 0.4 } });
    await waitFor(() => bob.got('object:materials') && vic.got('object:materials'), 'edit shared');
    check('an admin\'s edit reaches everyone as the full material record', () => {
        assert.deepEqual(vic.last('object:materials'), { id: 'chair', materials: { 0: { color: '#ff0000', metalness: 0.4 } } });
        assert.equal(ada.got('object:materials'), false);  // the sender already shows it
    });

    vic.send('object:material', { id: 'chair', index: 0, patch: { color: '#00ff00' } });
    await waitFor(() => vic.got('object:denied'), 'viewer denied');
    await sleep(150);
    check('a viewer\'s edit is refused and snapped back to the session\'s state', () => {
        assert.deepEqual(vic.last('object:materials').materials, { 0: { color: '#ff0000', metalness: 0.4 } });
        assert.equal(bob.count('object:materials'), 1);
    });

    bob.send('object:material', { id: 'chair', index: 1, patch: { roughness: 0.8 } });
    await waitFor(() => ada.got('object:materials'), 'bob edit');
    check('an editor\'s edit holds the free model for them', () => {
        assert.equal(ada.state.objects.find((o) => o.id === 'chair').heldBy, 'dev:bob');
    });

    cat.send('object:material', { id: 'chair', index: 0, patch: { color: '#0000ff' } });
    await waitFor(() => cat.got('object:denied'), 'cat denied');
    check('another editor cannot change a model someone holds', () => {
        assert.equal(cat.last('object:materials').materials[0].color, '#ff0000');
    });

    bob.send('object:material', { id: 'chair', index: 0, patch: { color: 'not-a-color' } });
    await waitFor(() => bob.got('action:denied', (d) => d.type === 'object:material'), 'invalid');
    check('an invalid edit is refused', () => assert.ok(true));


    console.log('\nTextures');

    const notImage = await post('/assets?kind=texture&name=x.png', bob.state.you.ticket, Buffer.from('hello, not an image at all'));
    const byViewer = await post('/assets?kind=texture&name=x.png', vic.state.you.ticket, PNG);
    const noTicket = await post('/assets?kind=texture&name=x.png', null, PNG);
    const texture = await post('/assets?kind=texture&name=wood.png', bob.state.you.ticket, PNG);
    check('texture uploads: images only, editors only, members only', () => {
        assert.equal(notImage.status, 415);
        assert.equal(byViewer.status, 403);
        assert.equal(noTicket.status, 401);
        assert.equal(texture.status, 200);
        assert.match(texture.json.textureId, /^[0-9a-f]{64}$/);
    });

    const usedBefore = ada.state.usedBytes;
    bob.send('object:material', { id: 'chair', index: 0, patch: { maps: { base: texture.json.textureId, normal: null } } });
    await waitFor(() => vic.got('object:materials', (p) => p.materials[0]?.maps?.base), 'texture shared');
    check('a texture edit keeps the other values and records a removed map as null', () => {
        assert.deepEqual(vic.last('object:materials').materials[0],
            { color: '#ff0000', metalness: 0.4, maps: { base: texture.json.textureId, normal: null } });
    });
    await waitFor(() => ada.state.usedBytes === usedBefore + PNG.length, 'counted');
    check('the texture counts in the session total', () => assert.equal(ada.state.usedBytes, usedBefore + PNG.length));

    const asMember = await fetch(texture.json.url, { headers: { Authorization: `Bearer ${vic.state.you.ticket}` } });
    const asNobody = await fetch(texture.json.url);
    check('members download the texture; the link alone does not', () => {
        assert.equal(asMember.status, 200);
        assert.equal(asMember.headers.get('content-type'), 'image/png');
        assert.equal(asNobody.status, 401);
    });

    const original = await fetch(up.json.url, { headers: { Authorization: `Bearer ${vic.state.you.ticket}` } });
    const originalBytes = Buffer.from(await original.arrayBuffer());
    check('the model file itself is unchanged', () => assert.ok(originalBytes.equals(glb)));


    console.log('\nLate joiners, versions, reopening');

    const dan = await connect('Dan');
    ada.send('join:approve', { userId: 'dev:dan', role: 'viewer' });
    await waitFor(() => dan.state.you.ticket, 'dan approved');
    dan.send('sync-request', { have: [] });
    await waitFor(() => dan.got('object:add', (p) => p.id === 'chair'), 'dan sync');
    check('someone joining later gets the edits with the model', () => {
        assert.equal(dan.last('object:add', (p) => p.id === 'chair').materials[0].maps.base, texture.json.textureId);
    });

    ada.send('scene:save', { name: 'Red chair' });
    await waitFor(() => bob.got('scene:saved', (p) => p.version.name === 'Red chair'), 'saved red');
    const red = bob.last('scene:saved').version;

    ada.send('object:material', { id: 'chair', index: 0, patch: { color: '#00ff00' } });
    await waitFor(() => bob.got('object:materials', (p) => p.materials[0]?.color === '#00ff00'), 'green');
    await sleep(3100);  // SAVE_COOLDOWN_SECONDS
    ada.send('scene:save', { name: 'Green chair' });
    await waitFor(() => bob.got('scene:saved', (p) => p.version.name === 'Green chair'), 'saved green');

    ada.send('scene:restore', { versionId: red.id });
    await waitFor(() => bob.got('scene:restored'), 'restored');
    await waitFor(() => bob.got('object:materials', (p) => p.materials[0]?.color === '#ff0000'), 'red again');
    check('restoring a version brings its materials back for everyone', () => {
        assert.deepEqual(dan.last('object:materials').materials[0].maps, { base: texture.json.textureId, normal: null });
    });

    const seen = vic.messages.length;
    bob.send('object:material', { id: 'chair', index: 1, patch: null });
    await waitFor(() => vic.messages.slice(seen).some((m) => m.type === 'object:materials'), 'reset');
    check('a material can go back to the model\'s own', () => {
        assert.deepEqual(Object.keys(vic.last('object:materials').materials), ['0']);
    });

    // Changed after the restore: saved when the session ends
    bob.send('object:material', { id: 'chair', index: 0, patch: { roughness: 0.3 } });
    await waitFor(() => vic.got('object:materials', (p) => p.materials[0]?.roughness === 0.3), 'last edit');
    for (const u of [bob, cat, vic, dan]) {
        u.room.leave();
    }
    ada.send('session:leave', { choice: 'close' });
    await waitFor(() => ada.leftCode !== null, 'closed');
    await sleep(700);

    const ada2 = await connect('Ada', 'create');
    ada2.send('sync-request', { have: [] });
    await waitFor(() => ada2.got('object:add', (p) => p.id === 'chair'), 'reopened');
    check('the owner reopens the session with the last materials and textures', () => {
        const chair = ada2.last('object:add', (p) => p.id === 'chair');
        assert.deepEqual(chair.materials, { 0: { color: '#ff0000', metalness: 0.4, roughness: 0.3, maps: { base: texture.json.textureId, normal: null } } });
        assert.equal(ada2.state.usedBytes, glb.length + PNG.length);
    });

    const reopenedTexture = await fetch(texture.json.url, { headers: { Authorization: `Bearer ${ada2.state.you.ticket}` } });
    check('its texture still downloads after reopening', () => assert.equal(reopenedTexture.status, 200));

    ada2.room.leave();

    console.log(`\nAll ${passed} material checks passed`);
}


main()
    .then(async () => {
        server.kill();
        await sleep(300);
        await rm(storageDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(error);
        console.error('\n--- server log ---\n' + serverLog.slice(-3000));
        server.kill();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(1);
    });
