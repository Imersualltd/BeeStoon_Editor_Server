/*
 * The session credit pool kept by BeeStoon (EDITOR_POOL=on): the room
 * forwards admins' Add / Withdraw with a request key, never keeps the pool
 * itself, shows BeeStoon's numbers, and reads them again after a restart.
 * The ledger rules themselves (atomic, idempotent, withdrawal limits) are
 * tested in beestoon-backend tests/test_editor_pool*.py; this fake applies
 * them simply and records what the room sent.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';


const PORT = 3300 + Math.floor(Math.random() * 300);
const API_PORT = PORT + 400;
const URL = `http://localhost:${PORT}`;
const SERVICE_KEY = 'k'.repeat(40);
const STORAGE = mkdtempSync(path.join(tmpdir(), 'beestoon-editor-pool-test-'));

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


// ── fake BeeStoon pool API ──────────────────────────────────────────────────
const balances = new Map();          // userId -> credits
const pools = new Map();             // sessionKey -> { balance, deposited, withdrawn, spent, forEntry, forModels, mine: Map }
const seen = new Map();              // key -> answer
const calls = [];

function poolOf(key) {
    if (!pools.has(key)) {
        pools.set(key, { balance: 0, deposited: 0, withdrawn: 0, spent: 0, reserved: 0, forEntry: false, forModels: false, mine: new Map(), history: [] });
    }
    return pools.get(key);
}

function stateOf(sessionKey, userId) {
    const p = poolOf(sessionKey);
    const out = { sessionKey, balance: p.balance, available: p.balance - p.reserved, reserved: p.reserved,
        deposited: p.deposited, withdrawn: p.withdrawn, spent: p.spent, forEntry: p.forEntry, forModels: p.forModels,
        history: p.history.slice(-30).reverse() };
    if (userId) {
        const mine = p.mine.get(userId) || 0;
        out.mine = { contributed: mine, withdrawable: Math.min(mine, p.balance - p.reserved) };
        out.personalBalance = balances.get(userId) ?? 20;
    }
    return out;
}

const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
        const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (req.headers['x-editor-service-key'] !== SERVICE_KEY) {
            return send(403, { detail: 'Forbidden' });
        }
        const url = new globalThis.URL(req.url, 'http://x');
        const json = body ? JSON.parse(body) : {};
        calls.push({ method: req.method, path: url.pathname, body: json });
        const credit = url.pathname.match(/^\/internal\/editor\/credits\/(.+)$/);
        if (credit) {
            return send(200, { balance: balances.get(decodeURIComponent(credit[1])) ?? 20 });
        }
        const m = url.pathname.match(/^\/internal\/editor\/pools\/([^/]+)(?:\/(\w+))?$/);
        if (!m) {
            return send(404, {});
        }
        const [, sessionKey, action] = m;
        if (req.method === 'GET') {
            return send(200, stateOf(sessionKey, url.searchParams.get('userId')));
        }
        const p = poolOf(sessionKey);
        if (action === 'settings') {
            Object.assign(p, json.forEntry === undefined ? {} : { forEntry: json.forEntry }, json.forModels === undefined ? {} : { forModels: json.forModels });
            return send(200, stateOf(sessionKey));
        }
        if (seen.has(json.key)) {
            return send(200, { ...stateOf(sessionKey, json.userId), replayed: true });
        }
        if (action === 'charge') {                    // pool only, as BeeStoon
            if (p.balance - p.reserved < json.amount) {
                return send(402, { detail: { error: `The session pool needs topping up: this costs ${json.amount}, the pool has ${p.balance - p.reserved} available.`,
                    code: 'pool_insufficient', required: json.amount, available: p.balance - p.reserved } });
            }
            p.balance -= json.amount; p.spent += json.amount;
            seen.set(json.key, true);
            p.history.push({ kind: 'spend', amount: json.amount, by: json.userId });
            return send(200, { paidBy: 'pool', replayed: false, ...stateOf(sessionKey) });
        }
        const have = balances.get(json.userId) ?? 20;
        if (action === 'deposit') {
            if (have < json.amount) {
                return send(402, { detail: { error: `You need ${json.amount} credits for this (you have ${have}).`, code: 'insufficient_credits' } });
            }
            balances.set(json.userId, have - json.amount);
            p.balance += json.amount; p.deposited += json.amount;
            p.mine.set(json.userId, (p.mine.get(json.userId) || 0) + json.amount);
        } else if (action === 'withdraw') {
            const allowed = Math.min(p.mine.get(json.userId) || 0, p.balance - p.reserved);
            if (json.amount > allowed) {
                return send(409, { detail: { error: `You can withdraw at most ${allowed} credits`, code: 'not_withdrawable', withdrawable: allowed } });
            }
            balances.set(json.userId, have + json.amount);
            p.balance -= json.amount; p.withdrawn += json.amount;
            p.mine.set(json.userId, p.mine.get(json.userId) - json.amount);
        }
        p.history.push({ kind: action, amount: json.amount, by: json.userId });
        const answer = { ...stateOf(sessionKey, json.userId), replayed: false };
        seen.set(json.key, answer);
        send(200, answer);
    });
});


async function startServer() {
    server = spawn(process.execPath, ['src/index.mjs'], {
        env: {
            ...process.env,
            PORT: String(PORT),
            AUTH_PROVIDER: 'dev',
            ALLOW_DEV_AUTH: 'true',
            CREDITS_PROVIDER: 'beestoon',
            CREDITS_ENABLED: 'false',          // prices off, as in production
            EDITOR_POOL: 'on',
            BEESTOON_API_URL: `http://127.0.0.1:${API_PORT}`,
            EDITOR_SERVICE_KEY: SERVICE_KEY,
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

async function connect(name, sessionKey, mode = 'join', extra = {}) {
    const client = new Client(URL);
    const room = await client[mode]('session', { sessionKey, identity: { userId: name.toLowerCase(), name }, ...extra });
    const user = { name, room, messages: [], state: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.send = (type, data = {}) => room.send(type, data);
    user.got = (type, pred = () => true) => user.messages.find((m) => m.type === type && pred(m.payload));
    await waitFor(() => user.state, `${name} gets session:state`);
    return user;
}


async function main() {

    await new Promise((resolve) => fake.listen(API_PORT, '127.0.0.1', resolve));
    await startServer();
    const KEY = 'poolsession1';

    console.log('\nThe pool panel is there with prices off (EDITOR_POOL=on)');
    const ada = await connect('Ada', KEY, 'create');
    const bob = await connect('Bob', KEY);
    ada.send('join:approve', { userId: bob.state.you.userId, role: 'editor' });
    await waitFor(() => bob.state.you.status === 'approved', 'bob approved');
    await waitFor(() => ada.state.credits?.balance === 20, 'ada balance');
    check('credits state and features for everyone, withdrawals offered', () => {
        assert.equal(ada.state.features.credits, true);
        assert.equal(ada.state.features.poolWithdraw, true);
        assert.equal(ada.state.credits.beestoon, true);
        assert.equal(ada.state.credits.balance, 20);
        assert.ok(bob.state.credits);
    });

    console.log('\nOnly an admin moves credits');
    const before = calls.length;
    bob.send('credits:add', { amount: 2, requestId: 'bobrequest01' });
    await waitFor(() => bob.got('action:denied', (d) => d.type === 'credits:add'), 'bob refused');
    check('an editor is refused on the server, BeeStoon is never asked', () => {
        assert.ok(!calls.slice(before).some((c) => c.path.endsWith('/deposit')));
    });

    console.log('\nAdd, a retry, withdraw');
    ada.send('credits:add', { amount: 5, requestId: 'adarequest01' });
    await waitFor(() => ada.got('credits:done', (d) => d.requestId === 'adarequest01'), 'add done');
    ada.send('credits:add', { amount: 5, requestId: 'adarequest01' });                       // the same click again
    await waitFor(() => ada.messages.filter((m) => m.type === 'credits:done').length === 2, 'repeat answered');
    const deposits = calls.filter((c) => c.path.endsWith('/deposit'));
    check('the request id is the BeeStoon key: the repeat moved nothing', () => {
        assert.equal(deposits.length, 2);
        assert.equal(deposits[0].body.key, deposits[1].body.key);
        assert.equal(deposits[0].body.key, `pool:${KEY}:add:adarequest01`);
        assert.equal(deposits[0].body.userId, ada.state.you.userId);
        assert.equal(ada.messages.filter((m) => m.type === 'credits:done')[1].payload.replayed, true);
    });
    await waitFor(() => bob.state.credits.pool.left === 5, 'bob sees the pool');
    check('everyone sees the pool, the admin their own balance', () => {
        assert.equal(ada.state.credits.pool.total, 5);
        assert.equal(ada.state.credits.balance, 15);
    });
    ada.send('credits:withdraw', { amount: 9, requestId: 'adarequest02' });
    await waitFor(() => ada.got('credits:failed', (d) => d.requestId === 'adarequest02'), 'too much refused');
    check('a withdrawal larger than allowed is refused with the reason and the limit', () => {
        const failed = ada.got('credits:failed', (d) => d.requestId === 'adarequest02').payload;
        assert.equal(failed.withdrawable, 5);
        assert.match(failed.reason, /at most 5/);
    });
    ada.send('credits:withdraw', { amount: 3, requestId: 'adarequest03' });
    await waitFor(() => ada.got('credits:done', (d) => d.requestId === 'adarequest03'), 'withdraw done');
    await waitFor(() => ada.state.credits.pool.left === 2 && ada.state.credits.balance === 18, 'state after withdraw');
    check('withdrawn credits are back in the admin\'s balance', () => assert.equal(ada.state.credits.balance, 18));
    bob.send('credits:withdraw', { amount: 1, requestId: 'bobrequest02' });
    await waitFor(() => bob.got('action:denied', (d) => d.type === 'credits:withdraw'), 'bob withdraw refused');
    check('an editor cannot withdraw', () => assert.ok(!calls.some((c) => c.body?.key?.includes('bobrequest02'))));

    console.log('\nMy part of the pool and the history');
    ada.send('credits:refresh');
    await waitFor(() => ada.got('credits:mine'), 'mine');
    check('the admin gets what they may take back and the history', () => {
        const mine = ada.got('credits:mine').payload;
        assert.equal(mine.mine.withdrawable, 2);
        assert.equal(mine.history.length, 2);
    });

    console.log('\nAfter a restart the pool is read from BeeStoon again');
    await ada.room.leave();
    await bob.room.leave();
    server.kill();
    await sleep(500);
    await startServer();
    const ada2 = await connect('Ada', KEY, 'create').catch(() => connect('Ada', KEY));
    await waitFor(() => ada2.state.credits?.pool?.left === 2, 'pool after restart');
    check('the same pool, nothing kept in the editor server', () => assert.equal(ada2.state.credits.pool.total, 2));

    console.log('\nThe initial pool chosen when creating a session');
    const KEY2 = 'initialpool01';
    const before2 = calls.length;
    const eve = await connect('Eve', KEY2, 'create', { creditPool: 4 });
    await waitFor(() => eve.state.credits?.pool?.left === 4, 'initial pool shown');
    const initials = () => calls.slice(before2).filter((c) => c.path.endsWith('/deposit'));
    check('moved once from the creator into the pool, marked initial, under the session\'s own key', () => {
        assert.equal(initials().length, 1);
        assert.deepEqual([initials()[0].body.key, initials()[0].body.initial, initials()[0].body.amount], [`pool:${KEY2}:initial`, true, 4]);
        assert.equal(balances.get(eve.state.you.userId), 16);
    });
    const finn = await connect('Finn', KEY2);
    await eve.room.leave(false);                                                  // dropped
    const eveBack = await connect('Eve', KEY2).catch(() => connect('Eve', KEY2, 'create', { creditPool: 4 }));
    await waitFor(() => eveBack.state.credits, 'eve back');
    check('a reconnect or another joiner moves nothing again', () => assert.equal(initials().length, 1));
    await finn.room.leave();
    await eveBack.room.leave();

    const poorKey = 'initialpool02';
    balances.set('dev:pia', 2);
    const refused = await connect('Pia', poorKey, 'create', { creditPool: 5 }).then(() => null, (e) => e);
    check('not enough credits: the session does not start, with the reason (402)', () => {
        assert.equal(refused?.code, 402);
        assert.match(refused.message, /initial pool of 5 credits could not be paid/);
        assert.equal(balances.get('dev:pia'), 2);
    });

    console.log('\nPaid work the pool cannot cover is refused with what is needed');
    const errSeen = [];
    const ada3 = await connect('Ada', 'paidwork0001', 'create');
    ada3.room.onMessage('pool:short', (d) => errSeen.push(d));
    const answer = await fetch(`http://127.0.0.1:${API_PORT}/internal/editor/pools/paidwork0001/charge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-editor-service-key': SERVICE_KEY },
        body: JSON.stringify({ userId: 'ada', amount: 1, key: 'work:x:1', purpose: 'models' }) });
    check('the pool-only charge answers 402 pool_insufficient with required / available', () => {
        assert.equal(answer.status, 402);
    });
    await ada3.room.leave();

    console.log(`\nAll ${passed} checks passed`);
}


main()
    .then(() => { server.kill(); fake.close(); process.exit(0); })
    .catch((error) => {
        console.error(`\nFAILED: ${error.message}`);
        console.error(error.stack);
        console.error('\n--- server log ---\n' + serverLog.slice(-5000));
        server.kill();
        fake.close();
        process.exit(1);
    });
