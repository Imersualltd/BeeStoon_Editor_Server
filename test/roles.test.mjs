/*
 * Roles / sessions test
 * --------------------------------------------------
 * Starts the server on a spare port (dev identity,
 * 2 s admin grace time) and plays a session with an
 * admin, editors, a viewer and a pending user.
 *
 *   npm test
 *
 * Exits with code 1 on the first failed check.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 2600 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;


// ==================================================
// HELPERS
// ==================================================

const TINY_GLB = 'data:model/gltf-binary;base64,AAAA';

const POSE = (x) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });


let passed = 0;

function check(label, fn) {

    fn();
    passed++;
    console.log(`  ok  ${label}`);
}


/*
 * One test user. Records every message so checks
 * can ask "did X arrive?" afterwards.
 */
async function connect(name, sessionKey, mode = 'join') {

    const client = new Client(URL);

    const room = await client[mode]('session', {
        sessionKey,
        identity: { userId: name.toLowerCase(), name }
    });

    const user = { name, room, messages: [], state: null, leftCode: null };

    room.onMessage('*', (type, payload) => {

        user.messages.push({ type, payload });

        if (type === 'session:state') {
            user.state = payload;
        }
    });

    room.onLeave((code) => {
        user.leftCode = code;
    });

    user.got = (type, pred = () => true) =>
        user.messages.some((m) => m.type === type && pred(m.payload));

    user.clear = () => {
        user.messages.length = 0;
    };

    user.send = (type, data = {}) => room.send(type, data);

    await waitFor(() => user.state, `${name} gets session:state`);

    return user;
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


async function rejects(promise, label) {

    try {
        await promise;
    } catch {
        return;
    }

    throw new Error(`Expected failure: ${label}`);
}


const objectIn = (user, id) => user.state.objects?.find((o) => o.id === id);
const userIn = (user, name) => user.state.users?.find((u) => u.name === name);


async function post(path, ticket) {

    const headers = { 'Content-Type': 'application/octet-stream' };

    if (ticket) {
        headers.Authorization = `Bearer ${ticket}`;
    }

    const res = await fetch(`${URL}${path}`, { method: 'POST', headers, body: Buffer.alloc(0) });

    return res.status;
}


// ==================================================
// SERVER
// ==================================================

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'dev',
        ALLOW_DEV_AUTH: 'true',
        ADMIN_GRACE_SECONDS: '2'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';

server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));


async function main() {

    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);


    console.log('\nSession, creator and waiting room');

    const KEY = 'test-session-0001';

    const admin = await connect('Ada', KEY, 'create');

    check('creator is admin', () => {
        assert.equal(admin.state.you.role, 'admin');
        assert.equal(admin.state.you.status, 'approved');
        assert.ok(admin.state.you.ticket);
    });

    const dup = await connect('Mallory', KEY, 'create').then(() => null, (e) => e);
    check('a used session key cannot be created again (409)', () => assert.equal(dup?.code, 409));

    const missing = await connect('Bob', 'no-such-session-xx').then(() => null, (e) => e);
    check('joining an unknown link fails', () => assert.ok(missing));
    console.log(`      (unknown link error: code ${missing.code}, "${missing.message}")`);


    admin.send('object:add', { id: 'chair', name: 'chair.glb', dataUrl: TINY_GLB, transform: POSE(0) });
    await waitFor(() => objectIn(admin, 'chair'), 'chair in admin state');

    const bob = await connect('Bob', KEY);
    const carol = await connect('Carol', KEY);
    const eve = await connect('Eve', KEY);
    const dave = await connect('Dave', KEY);

    check('joiners wait as pending and see nothing', () => {
        assert.equal(bob.state.you.status, 'pending');
        assert.equal(bob.state.users, undefined);
        assert.equal(bob.state.objects, undefined);
    });

    await waitFor(() => admin.got('join:request', (p) => p.name === 'Dave'), 'join requests');
    check('admin is told about every join request', () => {
        for (const n of ['Bob', 'Carol', 'Eve', 'Dave']) {
            assert.ok(admin.got('join:request', (p) => p.name === n), n);
        }
    });

    dave.send('sync-request', {});
    await sleep(200);
    check('pending user gets no model data, even when asking', () => {
        assert.ok(!dave.got('object:add'));
        assert.ok(!dave.got('object:list'));
    });


    console.log('\nApproval');

    admin.send('join:approve', { userId: 'dev:bob', role: 'editor' });
    admin.send('join:approve', { userId: 'dev:carol', role: 'viewer' });
    admin.send('join:approve', { userId: 'dev:eve', role: 'editor' });

    await waitFor(() => eve.state.you.status === 'approved', 'eve approved');

    check('approved users get role + ticket', () => {
        assert.equal(bob.state.you.role, 'editor');
        assert.equal(carol.state.you.role, 'viewer');
        assert.ok(bob.state.you.ticket);
    });

    check('only admins see pending people', () => {
        assert.ok(userIn(admin, 'Dave'));
        assert.equal(userIn(bob, 'Dave'), undefined);
    });

    bob.send('sync-request', {});
    await waitFor(() => bob.got('object:add', (p) => p.id === 'chair'), 'bob receives chair');
    check('approved user receives existing models on sync', () => {});


    console.log('\nEditing rules');

    carol.send('object:transform', { id: 'chair', ...POSE(5) });
    await waitFor(() => carol.got('object:denied'), 'viewer denied');
    check('viewer cannot move objects (and gets the pose to snap back to)', () => {
        const d = carol.messages.find((m) => m.type === 'object:denied').payload;
        assert.deepEqual(d.transform.position, [0, 0, 0]);
    });

    carol.send('object:add', { id: 'lamp', name: 'lamp.glb', dataUrl: TINY_GLB });
    await waitFor(() => carol.got('object:denied', (p) => p.id === 'lamp'), 'viewer add denied');
    check('viewer cannot import', () => assert.equal(objectIn(admin, 'lamp'), undefined));

    bob.send('object:hold', { id: 'chair' });
    await waitFor(() => objectIn(admin, 'chair')?.heldBy === 'dev:bob', 'bob holds chair');
    check('editor holds a free object', () => {});

    eve.clear();
    eve.send('object:transform', { id: 'chair', ...POSE(2) });
    await waitFor(() => eve.got('object:denied'), 'eve denied');
    check('another editor cannot move a held object', () => {
        assert.match(eve.messages.find((m) => m.type === 'object:denied').payload.reason, /Bob is editing/);
    });

    admin.clear();
    bob.send('object:transform', { id: 'chair', ...POSE(1) });
    await waitFor(() => admin.got('object:transform', (p) => p.position[0] === 1), 'bob move relayed');
    check('holder can move it and others see it', () => {
        assert.ok(!dave.got('object:transform'), 'pending must not get poses');
    });

    admin.send('object:transform', { id: 'chair', ...POSE(3) });
    await waitFor(() => bob.got('object:transform', (p) => p.position[0] === 3), 'admin move');
    check('admin ignores locks', () => {});

    admin.send('object:assign', { id: 'chair', userId: 'dev:eve' });
    await waitFor(() => objectIn(admin, 'chair')?.assignedTo === 'dev:eve', 'assigned');
    check('assigning to Eve drops Bob\'s hold', () => {
        assert.equal(objectIn(admin, 'chair').heldBy, null);
    });

    bob.clear();
    bob.send('object:transform', { id: 'chair', ...POSE(4) });
    await waitFor(() => bob.got('object:denied'), 'bob denied');
    check('editor cannot move an object assigned to someone else', () => {});

    admin.clear();
    eve.send('object:transform', { id: 'chair', ...POSE(6) });
    await waitFor(() => admin.got('object:transform', (p) => p.position[0] === 6), 'eve move');
    check('assignee can move it', () => {});

    bob.send('object:add', { id: 'table', name: 'table.glb', dataUrl: TINY_GLB, transform: POSE(0) });
    await waitFor(() => objectIn(admin, 'table'), 'table added');
    admin.send('object:swap', { idA: 'chair', idB: 'table' });
    await waitFor(() => objectIn(admin, 'table')?.assignedTo === 'dev:eve', 'swap');
    check('swap exchanges the two assignees', () => assert.equal(objectIn(admin, 'chair').assignedTo, null));

    // Eve still holds the chair from her move
    eve.send('object:release', { id: 'chair' });
    await waitFor(() => objectIn(admin, 'chair')?.heldBy === null, 'eve releases chair');
    bob.send('object:remove', { id: 'chair' });
    await waitFor(() => objectIn(admin, 'chair') === undefined, 'bob removes chair');
    check('editor can delete a free object', () => {});


    console.log('\nAdmin actions and HTTP tickets');

    carol.clear();
    carol.send('role:set', { userId: 'dev:carol', role: 'admin' });
    await waitFor(() => carol.got('action:denied'), 'carol self-promote denied');
    check('non-admin cannot change roles', () => {});

    admin.clear();
    admin.send('role:set', { userId: 'dev:ada', role: 'editor' });
    await waitFor(() => admin.got('action:denied'), 'last admin demote denied');
    check('last online admin cannot demote themselves', () => {});

    assert.equal(await post('/export/fbx'), 401);
    assert.equal(await post('/export/fbx', carol.state.you.ticket), 403);
    assert.notEqual(await post('/export/fbx', bob.state.you.ticket), 401);
    assert.notEqual(await post('/convert', bob.state.you.ticket), 403);
    check('HTTP routes: viewer 403, editor allowed', () => {});

    admin.send('role:set', { userId: 'dev:bob', role: 'viewer' });
    await waitFor(() => bob.state.you.role === 'viewer', 'bob demoted');
    assert.equal(await post('/export/fbx', bob.state.you.ticket), 403);
    check('demotion applies to HTTP immediately', () => {});
    admin.send('role:set', { userId: 'dev:bob', role: 'editor' });
    await waitFor(() => bob.state.you.role === 'editor', 'bob editor again');

    const carolTicket = carol.state.you.ticket;
    admin.send('user:kick', { userId: 'dev:carol' });
    await waitFor(() => carol.leftCode !== null, 'carol kicked');
    check('kicked user is disconnected with code 4101', () => assert.equal(carol.leftCode, 4101));
    assert.equal(await post('/export/fbx', carolTicket), 401);
    await rejects(connect('Carol', KEY), 'kicked user rejoins');
    check('kicked user cannot come back', () => {});

    admin.send('join:deny', { userId: 'dev:dave' });
    await waitFor(() => dave.leftCode !== null, 'dave denied');
    check('denied user is disconnected with code 4102', () => assert.equal(dave.leftCode, 4102));


    console.log('\nReturning user');

    await eve.room.leave();
    const eve2 = await connect('Eve', KEY);
    check('returning approved user keeps their role, no waiting', () => {
        assert.equal(eve2.state.you.status, 'approved');
        assert.equal(eve2.state.you.role, 'editor');
    });

    const eve3 = await connect('Eve', KEY);
    await waitFor(() => eve2.leftCode !== null, 'old tab replaced');
    check('same user in a new tab replaces the old one (4104)', () => assert.equal(eve2.leftCode, 4104));


    console.log('\nLast admin leaves ("keep") -> auto-promotion');

    admin.send('session:leave', { choice: 'keep' });
    await waitFor(() => admin.leftCode !== null, 'admin left');
    await waitFor(() => bob.state.you.role === 'admin', 'bob promoted', 15000);
    check('oldest online editor (Bob) becomes admin after the grace time', () => {
        assert.equal(eve3.state.you.role, 'editor');
        assert.ok(bob.got('session:notice'));
    });

    const ada2 = await connect('Ada', KEY);
    check('former admin returning keeps admin role', () => assert.equal(ada2.state.you.role, 'admin'));
    await ada2.room.leave();


    console.log('\nLast admin closes the session');

    await waitFor(() => !userIn(bob, 'Ada')?.online, 'ada offline');
    bob.send('session:leave', { choice: 'close' });
    await waitFor(() => eve3.leftCode !== null && bob.leftCode !== null, 'everyone disconnected');
    check('close disconnects everyone with 4103', () => {
        assert.equal(eve3.leftCode, 4103);
        assert.ok(eve3.got('session:closed'));
    });

    await sleep(300);
    await rejects(connect('Eve', KEY), 'join closed session');
    const recreate = await connect('Eve', KEY, 'create').then(() => null, (e) => e);
    check('closed session link no longer works, not even re-created (410)', () => {
        assert.ok(recreate, 're-create must fail');
        assert.equal(recreate.code, 410);
    });


    console.log('\nLast admin hands over and leaves ("assign")');

    const KEY2 = 'test-session-0002';
    const a = await connect('Ann', KEY2, 'create');
    const x = await connect('Xavi', KEY2);
    a.send('join:approve', { userId: 'dev:xavi', role: 'viewer' });
    await waitFor(() => x.state.you.status === 'approved', 'xavi approved');
    a.send('session:leave', { choice: 'assign', newAdminId: 'dev:xavi' });
    await waitFor(() => x.state.you.role === 'admin', 'xavi admin');
    check('assign makes the chosen person admin', () => {});

    await x.room.leave();
    await sleep(500);
    const again = await connect('Zed', KEY2, 'create');
    check('session ends when everyone left (key is free again)', () => assert.equal(again.state.you.role, 'admin'));


    console.log('\nAdmin alone leaves -> session closed');

    again.send('session:leave', { choice: 'keep' });
    await waitFor(() => again.leftCode !== null, 'zed left');
    check('admin alone leaving closes the session (4103)', () => assert.equal(again.leftCode, 4103));
    await sleep(300);
    const reopen = await connect('Zed', KEY2, 'create').then(() => null, (e) => e);
    check('its link no longer works (410)', () => assert.equal(reopen?.code, 410));


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
        console.error('\n--- server log ---\n' + serverLog);
        server.kill();
        process.exit(1);
    });
