/*
 * Editor analytics (analytics.mjs)
 * --------------------------------------------------
 * A fake BeeStoon API receives the events. One session:
 * Ada (owner) lets Ben in as editor and Cy as viewer,
 * denies Dan, adds models (from her device, a knife cut
 * by Ben), scales one, Ben works in VR and asks to save,
 * Ada approves, exports, changes Cy's role and removes
 * Cy. Checks what is sent, and what is never sent.
 *
 *   node test/analytics.test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3900 + Math.floor(Math.random() * 300);
const API_PORT = PORT + 400;
const URL = `http://localhost:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), 'beestoon-editor-analytics-'));
const SERVICE_KEY = 'service-key-for-tests-only-0123456789abc';
const TINY_GLB = 'data:model/gltf-binary;base64,AAAA';
const KEY = 'analyticsroom1';
const ID = {
    ada: '11111111-1111-4111-8111-111111111111',
    ben: '22222222-2222-4222-8222-222222222222',
    cy: '33333333-3333-4333-8333-333333333333',
    dan: '44444444-4444-4444-8444-444444444444'
};

let passed = 0;
let server = null;
let serverLog = '';
const received = [];
const headers = [];

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function waitFor(fn, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (fn()) {
            return;
        }
        await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
}

const of = (type) => received.filter((e) => e.type === type);


function startApi() {
    const api = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            if (req.method === 'POST' && req.url === '/internal/analytics/editor-events') {
                headers.push(req.headers);
                received.push(...JSON.parse(body).events);
                res.writeHead(204).end();
                return;
            }
            res.writeHead(404).end();
        });
    });
    return new Promise((resolve) => api.listen(API_PORT, () => resolve(api)));
}


async function startServer() {
    server = spawn(process.execPath, ['src/index.mjs'], {
        env: {
            ...process.env, PORT: String(PORT), AUTH_PROVIDER: 'dev', ALLOW_DEV_AUTH: 'true', MAIL_PROVIDER: 'log',
            SCENE_STORAGE: 'local', SCENE_LOCAL_DIR: STORAGE, AUTOSAVE_MINUTES: '0',
            ANALYTICS_EVENTS_ENABLED: 'true', BEESTOON_API_URL: `http://localhost:${API_PORT}`, EDITOR_SERVICE_KEY: SERVICE_KEY
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


async function connect(name, mode = 'join', options = {}) {
    const client = new Client(URL);
    const room = await client[mode]('session', {
        sessionKey: KEY, identity: { userId: ID[name.toLowerCase()], name, email: `${name.toLowerCase()}@x.example` }, ...options
    });
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


const pose = (scale) => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale });


async function main() {

    const api = await startApi();
    await startServer();

    const ada = await connect('Ada', 'create', { sessionType: 'basic', sessionName: 'Workshop A' });
    const ben = await connect('Ben');
    const cy = await connect('Cy');
    const dan = await connect('Dan');

    ada.send('join:approve', { userId: `dev:${ID.ben}`, role: 'editor' });
    ada.send('join:approve', { userId: `dev:${ID.cy}`, role: 'viewer' });
    ada.send('join:deny', { userId: `dev:${ID.dan}` });
    await waitFor(() => ben.state.you.status === 'approved' && cy.state.you.status === 'approved', 'approved');

    console.log('\nSession and people');
    await waitFor(() => of('editor_join_denied').length === 1 && of('editor_member_joined').length === 3, 'join events');
    const started = of('editor_session_started');
    check('one session start, with its owner, type, kind and name', () => {
        assert.equal(started.length, 1);
        assert.equal(started[0].user, ID.ada);
        assert.deepEqual(
            { kind: started[0].properties.kind, type: started[0].properties.session_type, name: started[0].properties.name },
            { kind: 'new', type: 'basic', name: 'Workshop A' }
        );
    });
    check('the session is a 16-hex reference, never the share key', () => {
        assert.match(started[0].session, /^[0-9a-f]{16}$/);
        assert.ok(received.every((e) => e.session === started[0].session));
        assert.ok(!JSON.stringify(received).includes(KEY));
    });
    check('people: the owner joins as admin, Ben and Cy are let in with their roles, Dan is denied', () => {
        const joined = Object.fromEntries(of('editor_member_joined').map((e) => [e.user, e.properties]));
        assert.equal(joined[ID.ada].via, 'owner');
        assert.equal(joined[ID.ada].role, 'admin');
        assert.deepEqual([joined[ID.ben].role, joined[ID.ben].via, joined[ID.ben].by], ['editor', 'approved', ID.ada]);
        assert.equal(joined[ID.cy].role, 'viewer');
        assert.equal(of('editor_join_requested').length, 3);
        assert.equal(of('editor_join_denied')[0].user, ID.dan);
    });

    console.log('\nModels, tools and imports');
    ada.send('object:add', { id: 'obj-1', name: 'chair.glb', dataUrl: TINY_GLB, origin: { tool: 'device' } });
    await waitFor(() => of('editor_model_added').length === 1, 'device add');
    ben.send('object:add', {
        id: 'obj-2', name: 'chair_cut_A.glb', dataUrl: TINY_GLB,
        origin: { tool: 'knife', detail: 'knife', from: ['obj-1'], op: 'op-abc123' }
    });
    ada.send('object:add', { id: 'obj-3', name: 'cube.glb', dataUrl: TINY_GLB, origin: { tool: 'shape', detail: 'box' } });
    ada.send('object:add', { id: 'obj-4', name: 'odd.glb', dataUrl: TINY_GLB, origin: { tool: 'rm -rf', detail: '<b>' } });
    ada.send('object:add', { id: 'obj-1', name: 'chair.glb', dataUrl: TINY_GLB, origin: { tool: 'device' } });   // resend
    await waitFor(() => of('editor_model_added').length === 4, 'adds');
    const adds = Object.fromEntries(of('editor_model_added').map((e) => [e.properties.object, e]));
    check('each model is recorded once with who added it, its size and what made it', () => {
        assert.equal(of('editor_model_added').length, 4);
        assert.deepEqual([adds['obj-1'].user, adds['obj-1'].properties.origin, adds['obj-1'].properties.name], [ID.ada, 'device', 'chair.glb']);
        assert.ok(adds['obj-1'].properties.bytes > 0);
        assert.deepEqual([adds['obj-2'].properties.origin, adds['obj-2'].properties.from, adds['obj-2'].properties.op], ['knife', ['obj-1'], 'op-abc123']);
        assert.deepEqual([adds['obj-3'].properties.origin, adds['obj-3'].properties.detail], ['shape', 'box']);
    });
    check('an unknown tool becomes "unknown", never what the client wrote', () => {
        assert.equal(adds['obj-4'].properties.origin, 'unknown');
        assert.equal(adds['obj-4'].properties.detail, undefined);
    });

    for (const s of [1.1, 1.2, 1.3]) {
        ada.send('object:transform', { id: 'obj-1', ...pose([s, s, s]) });
    }
    ada.send('object:transform', { id: 'obj-3', ...pose([1, 1, 1]) });   // moved, not scaled
    await waitFor(() => of('editor_tool_used').length >= 1, 'scale');
    await sleep(300);
    check('scaling is one tool use per gesture; a move without a size change is none', () => {
        const scales = of('editor_tool_used').filter((e) => e.properties.tool === 'scale');
        assert.equal(scales.length, 1);
        assert.deepEqual([scales[0].properties.object, scales[0].user], ['obj-1', ID.ada]);
    });

    console.log('\nVR and save approval');
    ben.send('analytics:usage', { kind: 'vr_start' });
    await waitFor(() => of('editor_vr_started').length === 1, 'vr start');
    ben.send('object:transform', { id: 'obj-2', ...pose([2, 2, 2]) });
    ben.send('object:transform', { id: 'obj-2', ...pose([2, 2, 2]) });
    ben.send('scene:save', { name: 'From VR' });
    await waitFor(() => ada.all('save:request').length === 1, 'save asked');
    ada.send('save:approve', { requestId: ada.last('save:request').requestId });
    await waitFor(() => of('editor_save_resolved').length === 1, 'save resolved');
    ben.send('analytics:usage', { kind: 'vr_end' });
    await waitFor(() => of('editor_vr_ended').length === 1, 'vr end');
    check('a save asked from VR is recorded, and its approval by the admin', () => {
        const asked = of('editor_save_requested')[0];
        const answer = of('editor_save_resolved')[0];
        assert.deepEqual([asked.user, asked.properties.vr, asked.properties.role], [ID.ben, true, 'editor']);
        assert.deepEqual([answer.properties.outcome, answer.properties.by, answer.properties.vr], ['approved', ID.ada, true]);
        assert.equal(answer.properties.request, asked.properties.request);
        assert.ok(of('editor_scene_saved').some((e) => e.properties.kind === 'approved' && e.user === ID.ben));
    });
    check('the VR session says how long it was and what changed in it', () => {
        const vr = of('editor_vr_ended')[0].properties;
        assert.equal(of('editor_vr_ended')[0].user, ID.ben);
        assert.equal(vr.moves, 2);
        assert.equal(vr.scales, 1);          // the second move kept the same size
        assert.ok(vr.duration_s >= 0);
        assert.ok(of('editor_tool_used').some((e) => e.properties.tool === 'scale' && e.properties.vr === true));
    });

    console.log('\nExports, AR on this device, roles and removals');
    ada.send('analytics:usage', { kind: 'export', format: 'fbx', scope: 'selected', objects: 1, ok: true, bytes: 1234 });
    ada.send('analytics:usage', { kind: 'export', format: 'glb', scope: 'all', objects: 3, ok: true });
    ada.send('analytics:usage', { kind: 'export', format: 'exe', scope: 'all', objects: 3 });
    ada.send('analytics:usage', { kind: 'ar_local' });
    ada.send('role:set', { userId: `dev:${ID.cy}`, role: 'editor' });
    await sleep(100);
    ada.send('user:kick', { userId: `dev:${ID.cy}` });
    await waitFor(() => of('editor_member_removed').length === 1 && of('editor_export').length === 2, 'removed');
    check('exports: format, single or multi object; an unknown format is ignored', () => {
        const ex = of('editor_export').map((e) => [e.properties.format, e.properties.scope, e.properties.multi]);
        assert.deepEqual(ex, [['fbx', 'selected', false], ['glb', 'all', true]]);
        assert.equal(of('editor_ar_local').length, 1);
    });
    check('role change and removal by the admin', () => {
        const role = of('editor_role_changed')[0];
        assert.deepEqual([role.user, role.properties.from, role.properties.to, role.properties.by], [ID.cy, 'viewer', 'editor', ID.ada]);
        const removed = of('editor_member_removed')[0];
        assert.deepEqual([removed.user, removed.properties.by, removed.properties.role], [ID.cy, ID.ada, 'editor']);
    });

    console.log('\nLeaving and the end of the session');
    // (Dan was denied: his connection is closed already)
    const leave = (u) => Promise.race([u.room.leave().catch(() => {}), sleep(2000)]);
    await leave(ben);
    await waitFor(() => of('editor_member_left').some((e) => e.user === ID.ben), 'ben left');
    await leave(ada);
    await waitFor(() => of('editor_session_ended').length === 1, 'ended');
    check('the session end has its duration, people and models', () => {
        const end = of('editor_session_ended')[0].properties;
        assert.equal(end.people_total, 4);
        assert.equal(end.people_peak, 3);
        assert.equal(end.objects, 4);
    });

    check('sent with the service key; every event has an id, a type and a time', () => {
        assert.ok(headers.every((h) => h['x-editor-service-key'] === SERVICE_KEY));
        assert.ok(received.every((e) => /^[0-9a-f]{32}$/.test(e.id) && e.type.startsWith('editor_') && !Number.isNaN(Date.parse(e.at))));
        assert.equal(new Set(received.map((e) => e.id)).size, received.length);
    });
    check('never an email, a link, a data URL or a pose', () => {
        const text = JSON.stringify(received);
        assert.ok(!/@x\.example|data:model|https?:\/\/|"position"|"rotation"/.test(text), text.slice(0, 400));
    });

    server.kill();
    api.close();

    console.log('\nBackfill from scene storage (scripts/analytics-backfill.mjs)');
    process.env.SCENE_STORAGE = 'local';
    process.env.SCENE_LOCAL_DIR = STORAGE;
    const { eventsOfSession } = await import('../scripts/analytics-backfill.mjs');
    const history = await eventsOfSession(KEY);
    const again = await eventsOfSession(KEY);
    const kinds = (type) => history.filter((e) => e.type === type);
    check('the session record gives its owner, type, members with roles and the removed person', () => {
        const start = kinds('editor_session_started')[0];
        assert.deepEqual([start.user, start.properties.session_type, start.properties.backfilled], [ID.ada, 'basic', true]);
        const roles = Object.fromEntries(kinds('editor_member_joined').map((e) => [e.user, e.properties.role]));
        // Cy was a viewer in a saved version, then removed: both are history
        assert.deepEqual(roles, { [ID.ada]: 'admin', [ID.ben]: 'editor', [ID.cy]: 'viewer' });
        assert.deepEqual(kinds('editor_member_removed').map((e) => e.user), [ID.cy]);
        assert.equal(start.session, started[0].session);
    });
    check('saved versions give each save and each model once, with its size and who added it', () => {
        assert.ok(kinds('editor_scene_saved').length >= 1);
        const models = Object.fromEntries(kinds('editor_model_added').map((e) => [e.properties.object, e]));
        assert.equal(models['obj-1'].user, ID.ada);
        assert.ok(models['obj-1'].properties.bytes > 0);
    });
    check('running it again gives the same ids (stored once)', () => {
        assert.deepEqual(again.map((e) => e.id), history.map((e) => e.id));
    });

    console.log(`\n${passed} checks passed`);
}


main().catch((error) => {
    console.error(error);
    console.error(serverLog.slice(-3000));
    server?.kill();
    process.exit(1);
});
