/*
 * Session pool for BeeStoon purchases + paid feature switches
 * --------------------------------------------------
 * The backend asks POST /internal/sessions/<key>/pool/spend
 * whether the pool pays a model import. Checks: service key,
 * admin setting, members only, live sessions only, one spend
 * per key, no overspending under parallel requests, refunds
 * once, everyone sees the new pool. credits:refresh re-reads
 * a balance changed outside the editor. With real BeeStoon
 * credits, paid features are off until switched on.
 *
 *   node test/pool.test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import { Client } from '@colyseus/sdk';


const SECRET = 'editor-secret-for-tests-only-0123456789';
const SERVICE_KEY = 'service-key-for-tests-only-0123456789abc';
const KEY = 'pool-session-0001';
const ID = { ada: '11111111-1111-4111-8111-111111111111', bob: '22222222-2222-4222-8222-222222222222' };

let passed = 0;

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

async function waitFor(fn, label, timeout = 4000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await fn()) {
            return;
        }
        await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
}


// Fake BeeStoon ledger (balances only; charges always succeed when covered)
const balances = new Map([[`jwt:${ID.ada}`, 20], [`jwt:${ID.bob}`, 5]]);
const ledger = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
            res.end(JSON.stringify({ balance: balances.get(decodeURIComponent(req.url.split('/').pop())) ?? 0 }));
            return;
        }
        const data = JSON.parse(body);
        balances.set(data.userId, (balances.get(data.userId) ?? 0) - data.amount);
        res.end(JSON.stringify({ balance: balances.get(data.userId) }));
    });
});
await new Promise((resolve) => ledger.listen(0, '127.0.0.1', resolve));

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-pool-test-'));
const servers = [];

function startServer(port, extra) {
    const child = spawn(process.execPath, ['src/index.mjs'], {
        env: {
            ...process.env,
            PORT: String(port),
            AUTH_PROVIDER: 'jwt',
            JWT_SECRET: SECRET,
            JWT_ISSUER: 'beestoon-api',
            JWT_AUDIENCE: 'beestoon-editor',
            CREDITS_PROVIDER: 'beestoon',
            BEESTOON_API_URL: `http://127.0.0.1:${ledger.address().port}`,
            EDITOR_SERVICE_KEY: SERVICE_KEY,
            AR_STORAGE: 'local',
            AR_LOCAL_DIR: path.join(storageDir, `ar-${port}`),
            SCENE_STORAGE: 'local',
            SCENE_LOCAL_DIR: path.join(storageDir, `scenes-${port}`),
            ...extra
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const handle = { child, log: '' };
    child.stdout.on('data', (d) => (handle.log += d));
    child.stderr.on('data', (d) => (handle.log += d));
    servers.push(handle);
    return handle;
}

const PORT = 3900 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const on = startServer(PORT, { EDITOR_PAID_FEATURES: 'sessions,entry,upgrade,pool' });
const off = startServer(PORT + 1, {});

const token = (who) => jwt.sign({ sub: ID[who], name: who, email: `${who}@test.org`, email_verified: true }, SECRET,
    { algorithm: 'HS256', issuer: 'beestoon-api', audience: 'beestoon-editor', expiresIn: '15m' });

async function connect(base, who, mode = 'join', extra = {}) {
    const client = new Client(base);
    client.auth.token = token(who);
    const room = await client[mode]('session', { sessionKey: KEY, ...extra });
    const user = { room, messages: [], state: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.send = (type, data = {}) => room.send(type, data);
    await waitFor(() => user.state, 'state');
    return user;
}

async function pool(action, body, key = SERVICE_KEY, sessionKey = KEY) {
    const res = await fetch(`${BASE}/internal/sessions/${sessionKey}/pool/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Editor-Service-Key': key } : {}) },
        body: JSON.stringify(body)
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const spend = (key, userId = `jwt:${ID.bob}`, amount = 1) => pool('spend', { userId, amount, key });


async function main() {

    await waitFor(() => on.log.includes('listening') && off.log.includes('listening'), 'servers', 15000);

    console.log('\nPaid features off by default');

    const refused = await connect(`http://localhost:${PORT + 1}`, 'ada', 'create', { sessionType: 'single' })
        .then(() => null, (e) => e);
    check('without EDITOR_PAID_FEATURES a new session is refused, not given away free', () => {
        assert.ok(refused);
        assert.match(refused.message, /not available yet/);
        assert.equal(balances.get(`jwt:${ID.ada}`), 20);
    });


    console.log('\nPool pays BeeStoon purchases');

    const ada = await connect(BASE, 'ada', 'create', { sessionType: 'basic', creditPool: 5, poolForEntry: false, poolForModels: false });
    const bob = await connect(BASE, 'bob');
    ada.send('join:approve', { userId: `jwt:${ID.bob}`, role: 'editor' });
    await waitFor(() => bob.state.you.status === 'approved', 'bob in');
    check('with paid features on, the pool comes from the creator\'s BeeStoon credits', () => {
        assert.equal(balances.get(`jwt:${ID.ada}`), 20 - 2 - 5);
        assert.equal(ada.state.credits.pool.left, 5);
        assert.deepEqual(ada.state.features.paid, { sessions: true, entry: true, upgrade: true, pool: true });
    });

    const noKey = await pool('spend', { userId: `jwt:${ID.bob}`, amount: 1, key: 'editor-import:aaaaaaaa' }, null);
    const offSpend = await spend('editor-import:aaaaaaaa');
    check('without the service key nothing; with the admin setting off the pool does not pay', () => {
        assert.equal(noKey.status, 404);
        assert.deepEqual(offSpend.json, { paid: false, reason: 'pool_off' });
    });

    ada.send('credits:pool', { forModels: true });
    await waitFor(() => ada.state.credits.pool.forModels, 'pool pays models');

    const first = await spend('editor-import:bbbbbbbb');
    const again = await spend('editor-import:bbbbbbbb');
    await waitFor(() => bob.state.credits.pool.left === 4, 'everyone sees 4');
    check('the pool pays once per purchase key, and everyone sees the pool go down', () => {
        assert.deepEqual(first.json, { paid: true, left: 4 });
        assert.equal(again.json.paid, true);
        assert.equal(again.json.replayed, true);
        assert.equal(ada.state.credits.pool.left, 4);
    });

    const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) => spend(`editor-import:p${i}aaaaaaa`)));
    check('parallel purchases never spend more than the pool has', () => {
        assert.equal(parallel.filter((r) => r.json.paid).length, 4);
        assert.ok(parallel.filter((r) => !r.json.paid).every((r) => r.json.reason === 'pool_low'));
    });
    await waitFor(() => ada.state.credits.pool.left === 0, 'pool empty');

    const stranger = await spend('editor-import:cccccccc', 'jwt:99999999-9999-4999-8999-999999999999');
    const elsewhere = await pool('spend', { userId: `jwt:${ID.bob}`, amount: 1, key: 'editor-import:dddddddd' }, SERVICE_KEY, 'not-a-live-session');
    check('only members of a live session can be paid for', () => {
        assert.equal(stranger.status, 403);
        assert.deepEqual(elsewhere.json, { paid: false, reason: 'not_live' });
    });

    const refunded = await pool('refund', { key: 'editor-import:bbbbbbbb' });
    const refundedAgain = await pool('refund', { key: 'editor-import:bbbbbbbb' });
    await waitFor(() => bob.state.credits.pool.left === 1, 'refund seen');
    check('a purchase that did not go through gives the pool its credit back, once', () => {
        assert.equal(refunded.json.refunded, true);
        assert.equal(refundedAgain.json.refunded, false);
    });


    console.log('\nBalances refresh');

    balances.set(`jwt:${ID.bob}`, 2);  // e.g. paid an import on BeeStoon
    bob.send('credits:refresh');
    await waitFor(() => bob.state.credits.balance === 2, 'bob balance refreshed');
    check('credits:refresh shows a balance changed outside the editor', () => assert.ok(true));

    ada.room.leave();
    bob.room.leave();

    console.log(`\nAll ${passed} pool checks passed`);
}


async function stop(code) {
    for (const s of servers) {
        s.child.kill();
    }
    ledger.close();
    await sleep(300);
    await rm(storageDir, { recursive: true, force: true });
    process.exit(code);
}

main()
    .then(() => stop(0))
    .catch(async (error) => {
        console.error(error);
        console.error('\n--- server log ---\n' + on.log.slice(-3000));
        await stop(1);
    });
