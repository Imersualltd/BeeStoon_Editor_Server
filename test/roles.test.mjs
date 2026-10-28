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
async function connect(name, sessionKey, mode = 'join', email = undefined) {

    const client = new Client(URL);

    const room = await client[mode]('session', {
        sessionKey,
        identity: { userId: name.toLowerCase(), name, email }
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
        ADMIN_GRACE_SECONDS: '2',
        RECONNECT_WINDOW: '1',
        // Invite emails go to the server log
        MAIL_PROVIDER: 'log'
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


    console.log('\nSame login in a second browser');

    admin.clear();
    const eve3 = await connect('Eve', KEY);
    await waitFor(() => userIn(admin, 'Eve')?.devices === 2, 'eve on two devices');
    check('second browser joins as the same person, same role, no waiting', () => {
        assert.equal(eve3.state.you.status, 'approved');
        assert.equal(eve3.state.you.role, 'editor');
        assert.equal(eve2.leftCode, null, 'first browser stays connected');
        assert.equal(admin.state.users.filter((u) => u.name === 'Eve').length, 1, 'one row');
        assert.ok(admin.state.connections >= 4, 'admin sees the connection count');
    });

    check('no join request for a second browser', () => {
        assert.ok(!admin.got('join:request', (p) => p.name === 'Eve'));
    });

    eve2.clear();
    eve3.clear();
    bob.send('object:add', { id: 'vase', name: 'vase.glb', dataUrl: TINY_GLB, transform: POSE(0) });
    await waitFor(() => eve2.got('object:add', (p) => p.id === 'vase') && eve3.got('object:add', (p) => p.id === 'vase'), 'both eve browsers get vase');
    check('both browsers receive changes', () => {});

    eve3.clear();
    eve2.send('object:transform', { id: 'vase', ...POSE(7) });
    await waitFor(() => eve3.got('object:transform', (p) => p.id === 'vase' && p.position[0] === 7), 'eve3 sees eve2 move');
    check('a change in one browser reaches the person\'s other browser', () => {});

    eve2.send('object:release', { id: 'vase' });
    eve2.send('session:leave', { choice: 'keep' });
    await waitFor(() => eve2.leftCode !== null && userIn(admin, 'Eve')?.devices === 1, 'eve2 left');
    check('leaving in one browser keeps the other one in', () => {
        assert.equal(eve3.leftCode, null);
        assert.equal(userIn(admin, 'Eve').online, true);
    });


    console.log('\nAn admin leaves while another admin is online');

    admin.send('role:set', { userId: 'dev:bob', role: 'admin' });
    await waitFor(() => bob.state.you.role === 'admin', 'bob admin');
    admin.send('session:leave', { choice: 'keep' });
    await waitFor(() => admin.leftCode !== null, 'admin left');
    await sleep(300);
    check('the session goes on (Ada just left)', () => {
        assert.notEqual(admin.leftCode, 4103);
        assert.equal(eve3.leftCode, null);
    });

    const ada2 = await connect('Ada', KEY);
    check('former admin returning keeps admin role', () => assert.equal(ada2.state.you.role, 'admin'));
    await ada2.room.leave();


    console.log('\nLast admin leaves -> session closed for everyone');

    await waitFor(() => !userIn(bob, 'Ada')?.online, 'ada offline');
    bob.send('session:leave', { choice: 'keep' });
    await waitFor(() => eve3.leftCode !== null && bob.leftCode !== null, 'everyone disconnected');
    check('last admin leaving disconnects everyone with 4103', () => {
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

    check('the session goes on after a hand-over', () => assert.equal(x.leftCode, null));


    console.log('\nLast admin closes the tab and does not come back');

    const y = await connect('Yan', KEY2);
    x.send('join:approve', { userId: 'dev:yan', role: 'editor' });
    await waitFor(() => y.state.you.status === 'approved', 'yan approved');
    await x.room.leave(false);   // like closing the tab
    await waitFor(() => y.leftCode !== null, 'yan disconnected', 10000);
    check('session closes once the reconnect window runs out (4103)', () => assert.equal(y.leftCode, 4103));
    await sleep(300);
    const reopen2 = await connect('Xavi', KEY2, 'create').then(() => null, (e) => e);
    check('its link no longer works (410)', () => assert.equal(reopen2?.code, 410));

    const KEY3 = 'test-session-0003';
    const again = await connect('Zed', KEY3, 'create');


    console.log('\nEmail invites');

    const KEY4 = 'test-session-0004';
    const host = await connect('Hana', KEY4, 'create');
    const LINK4 = `https://example.test/launch?session=${KEY4}`;

    check('admins are told the server can send invites', () => {
        assert.equal(host.state.features?.emailInvites, true);
    });

    host.send('invite:email', { emails: ['Gus@Example.com', 'not-an-email'], role: 'viewer', note: 'Come in', link: LINK4 });
    await waitFor(() => host.got('invite:result'), 'invite result');
    check('invite is sent to valid addresses and reports the bad ones', () => {
        const r = host.messages.find((m) => m.type === 'invite:result').payload;
        assert.deepEqual(r.sent, ['gus@example.com']);
        assert.equal(r.failed.length, 1);
        assert.ok(serverLog.includes('[mail] invite to gus@example.com'));
    });

    host.clear();
    host.send('invite:email', { emails: ['x@example.com'], role: 'editor', link: 'https://example.test/?session=other-session-9' });
    await waitFor(() => host.got('action:denied', (p) => p.type === 'invite:email'), 'wrong link denied');
    check('an invite link for another session is refused', () => {});

    const gus = await connect('Gus', KEY4, 'join', 'gus@example.com');
    check('invited email joins straight away with the invited role', () => {
        assert.equal(gus.state.you.status, 'approved');
        assert.equal(gus.state.you.role, 'viewer');
    });

    const ivy = await connect('Ivy', KEY4, 'join', 'ivy@example.com');
    check('someone who was not invited still waits', () => assert.equal(ivy.state.you.status, 'pending'));

    host.send('join:approve', { userId: 'dev:ivy', role: 'editor' });
    await waitFor(() => ivy.state.you.status === 'approved', 'ivy approved');
    ivy.clear();
    ivy.send('invite:email', { emails: ['y@example.com'], role: 'admin', link: LINK4 });
    await waitFor(() => ivy.got('action:denied', (p) => p.type === 'invite:email'), 'editor invite denied');
    check('only admins can invite', () => assert.equal(ivy.state.features?.emailInvites, false));


    console.log('\nAdmin in two browsers');

    const hana2 = await connect('Hana', KEY4);
    await waitFor(() => userIn(host, 'Hana')?.devices === 2, 'hana on two devices');
    host.send('session:leave', { choice: 'keep' });
    await waitFor(() => host.leftCode !== null, 'hana first browser left');
    await sleep(300);
    check('admin leaving one of two browsers does not close the session', () => {
        assert.notEqual(host.leftCode, 4103);
        assert.equal(gus.leftCode, null);
        assert.equal(hana2.state.you.role, 'admin');
    });

    hana2.send('session:leave', { choice: 'close' });
    await waitFor(() => gus.leftCode !== null, 'session closed');
    check('closing from the last browser ends it for everyone (4103)', () => assert.equal(gus.leftCode, 4103));


    console.log('\nAdmin alone leaves -> session closed');

    again.send('session:leave', { choice: 'keep' });
    await waitFor(() => again.leftCode !== null, 'zed left');
    check('admin alone leaving closes the session (4103)', () => assert.equal(again.leftCode, 4103));
    await sleep(300);
    const reopen = await connect('Zed', KEY3, 'create').then(() => null, (e) => e);
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
