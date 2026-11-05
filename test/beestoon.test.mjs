/*
 * BeeStoon integration test
 * --------------------------------------------------
 * The server as it runs behind the BeeStoon site:
 * AUTH_PROVIDER=jwt with the editor's own secret,
 * issuer and audience; credits in the BeeStoon ledger
 * (a fake ledger runs in this process and records every
 * call); email invites captured to a folder (nothing is
 * sent); CORS limited to the site.
 *
 *   node test/beestoon.test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import { Client } from '@colyseus/sdk';

import { productionProblems } from '../src/auth/index.mjs';


const PORT = 3300 + Math.floor(Math.random() * 300);
const SERVER = `http://localhost:${PORT}`;
const SECRET = 'editor-secret-for-tests-only-0123456789';
const SERVICE_KEY = 'service-key-for-tests-only-0123456789abc';
const SITE = 'https://site.test';
const KEY = 'beestoon-session-01';


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


// ==================================================
// FAKE BEESTOON LEDGER
// ==================================================

const ledger = { balances: new Map(), calls: [], keys: new Map() };

const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        if (req.headers['x-editor-service-key'] !== SERVICE_KEY) {
            return send(403, {});
        }
        const data = body ? JSON.parse(body) : {};
        ledger.calls.push({ method: req.method, url: req.url, data });
        if (req.method === 'GET') {
            const id = decodeURIComponent(req.url.split('/').pop());
            return send(200, { balance: ledger.balances.get(id) ?? 0 });
        }
        if (ledger.keys.has(data.key)) {
            return send(200, { balance: ledger.balances.get(data.userId), replayed: true });
        }
        const balance = ledger.balances.get(data.userId) ?? 0;
        if (balance < data.amount) {
            return send(402, { detail: { error: `You need ${data.amount} credits`, balance } });
        }
        ledger.keys.set(data.key, data);
        ledger.balances.set(data.userId, balance - data.amount);
        return send(200, { balance: balance - data.amount });
    });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const LEDGER = `http://127.0.0.1:${fake.address().port}`;


// ==================================================
// SERVER
// ==================================================

const storageDir = await mkdtemp(path.join(tmpdir(), 'beestoon-editor-bs-test-'));
const mailDir = path.join(storageDir, 'mail');

const server = spawn(process.execPath, ['src/index.mjs'], {
    env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_PROVIDER: 'jwt',
        JWT_SECRET: SECRET,
        JWT_ISSUER: 'beestoon-api',
        JWT_AUDIENCE: 'beestoon-editor',
        CORS_ORIGINS: SITE,
        CREDITS_PROVIDER: 'beestoon',
        // Prices confirmed (the default is all off, see pool.test.mjs)
        EDITOR_PAID_FEATURES: 'sessions,entry,upgrade,pool',
        BEESTOON_API_URL: LEDGER,
        EDITOR_SERVICE_KEY: SERVICE_KEY,
        MAIL_PROVIDER: 'capture',
        MAIL_CAPTURE_DIR: mailDir,
        INVITE_BASE_URL: `${SITE}/editor`,
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


function token(sub, claims = {}, options = {}) {
    return jwt.sign(
        { sub, name: sub.slice(0, 3), ...claims },
        options.secret || SECRET,
        { algorithm: 'HS256', issuer: 'beestoon-api', audience: 'beestoon-editor', expiresIn: '15m', ...options.sign }
    );
}

const ID = {
    ada: '11111111-1111-4111-8111-111111111111',
    bob: '22222222-2222-4222-8222-222222222222',
    cat: '33333333-3333-4333-8333-333333333333',
    dan: '44444444-4444-4444-8444-444444444444'
};


async function connect(raw, mode = 'join', extra = {}) {
    const client = new Client(SERVER);
    client.auth.token = raw;
    const room = await client[mode]('session', { sessionKey: KEY, ...extra });
    const user = { room, messages: [], state: null };
    room.onMessage('*', (type, payload) => {
        user.messages.push({ type, payload });
        if (type === 'session:state') {
            user.state = payload;
        }
    });
    user.got = (type, pred = () => true) => user.messages.some((m) => m.type === type && pred(m.payload));
    user.send = (type, data = {}) => room.send(type, data);
    await waitFor(() => user.state, 'session:state');
    return user;
}


async function members(userId, key = SERVICE_KEY) {
    const res = await fetch(`${SERVER}/internal/sessions/${KEY}/members/${encodeURIComponent(userId)}`, {
        headers: key ? { 'X-Editor-Service-Key': key } : {}
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}


async function main() {

    await waitFor(() => serverLog.includes('listening'), 'server start', 15000);

    console.log('\nProduction settings');

    check('development settings are refused in production', () => {
        const problems = productionProblems({ NODE_ENV: 'production', AUTH_PROVIDER: 'dev', ALLOW_DEV_AUTH: 'true',
            CORS_ORIGINS: '*', INVITE_BASE_URL: 'https://beestoon.example/editor' });
        for (const text of ['AUTH_PROVIDER', 'ALLOW_DEV_AUTH', 'JWT_AUDIENCE', 'CORS_ORIGINS', 'placeholder', 'credits']) {
            assert.ok(problems.some((p) => p.includes(text)), text);
        }
    });

    check('the BeeStoon production settings pass', () => {
        assert.deepEqual(productionProblems({ NODE_ENV: 'production', AUTH_PROVIDER: 'jwt', JWT_SECRET: SECRET,
            JWT_ISSUER: 'beestoon-api', JWT_AUDIENCE: 'beestoon-editor', CORS_ORIGINS: SITE,
            INVITE_BASE_URL: `${SITE}/editor`, CREDITS_PROVIDER: 'beestoon',
            BEESTOON_API_URL: 'https://api.site.test', EDITOR_SERVICE_KEY: SERVICE_KEY }), []);
    });


    console.log('\nLogin tokens');

    // Ada has 5 credits; a basic session costs 2
    ledger.balances.set(`jwt:${ID.ada}`, 5);
    ledger.balances.set(`jwt:${ID.bob}`, 0);
    ledger.balances.set(`jwt:${ID.cat}`, 3);
    ledger.balances.set(`jwt:${ID.dan}`, 3);

    const ada = await connect(token(ID.ada, { email: 'ada@test.org', email_verified: true }), 'create',
        { sessionType: 'basic', sessionName: 'Studio' });
    check('the creator is jwt:<account id> and pays the session in the BeeStoon ledger', () => {
        assert.equal(ada.state.you.userId, `jwt:${ID.ada}`);
        const create = ledger.calls.find((c) => c.url.endsWith('/charge'));
        assert.equal(create.data.userId, `jwt:${ID.ada}`);
        assert.equal(create.data.amount, 2);
        assert.match(create.data.key, /^editor:[A-Za-z0-9_-]{20,64}:create$/);
        assert.equal(ledger.balances.get(`jwt:${ID.ada}`), 3);
    });

    const refused = async (raw) => connect(raw, 'join').then((u) => { u.room.leave(); return null; }, (e) => e);

    const wrongAudience = await refused(token(ID.ada, {}, { sign: { audience: 'beestoon-site' } }));
    const siteSecret = await refused(token(ID.ada, {}, { secret: 'the-sites-own-signing-secret-000000000' }));
    const longLived = await refused(token(ID.ada, {}, { sign: { expiresIn: '7d' } }));
    const expired = await refused(token(ID.ada, {}, { sign: { expiresIn: -10 } }));
    check('wrong audience, the site secret, 7-day and expired tokens are refused', () => {
        // Colyseus answers a refused login with AUTH_FAILED (525)
        for (const e of [wrongAudience, siteSecret, longLived, expired]) {
            assert.ok([401, 525].includes(e?.code), String(e?.code));
        }
    });

    check('generation is priced by BeeStoon, not by the editor server', () => {
        assert.equal(ada.state.features.generationCharge, false);
    });

    const chargesBefore = ledger.calls.length;
    ada.send('generation:charge', { requestId: 'gen-1', cost: 0 });
    await waitFor(() => ada.got('generation:charged'), 'generation answer');
    check('generation:charge books nothing and cannot be used as a price', () => {
        assert.ok(ada.got('generation:charged', (p) => p.paidBy === 'free' && p.cost === 0));
        assert.equal(ledger.calls.length, chargesBefore);
    });

    const poor = await connect(token(ID.bob, { email: 'bob@test.org', email_verified: true })).then(() => null, (e) => e);
    check('someone without credits cannot join (402), nobody gets free credits', () => {
        assert.equal(poor?.code, 402);
    });


    console.log('\nInvitations');

    ada.send('invite:email', { emails: ['cat@test.org', 'dan@test.org'], role: 'editor',
        link: 'https://evil.test/phish?session=' + KEY });
    await waitFor(() => ada.got('invite:result'), 'invite result');
    const mails = await Promise.all((await readdir(mailDir)).map(async (f) => JSON.parse(await readFile(path.join(mailDir, f), 'utf8'))));
    check('invites are captured locally and link to the site editor page, never the client\'s link', () => {
        assert.equal(mails.length, 2);
        for (const mail of mails) {
            assert.equal(mail.link, `${SITE}/editor?session=${KEY}`);
        }
        assert.deepEqual(ada.state.invites.map((i) => i.email).sort(), ['cat@test.org', 'dan@test.org']);
        assert.ok(ada.state.invites.every((i) => Date.parse(i.expiresAt) > Date.now()));
    });

    // Cat's login does not say the email is verified: she waits like anyone else
    const cat = await connect(token(ID.cat, { email: 'cat@test.org' }));
    check('an unverified (or unconfirmed) email does not use the invite', () => {
        assert.equal(cat.state.you.status, 'pending');
    });

    ada.send('invite:revoke', { email: 'dan@test.org' });
    await waitFor(() => ada.state.invites.length === 1, 'revoked');
    const dan = await connect(token(ID.dan, { email: 'dan@test.org', email_verified: true }));
    check('a revoked invite lets nobody in straight away', () => assert.equal(dan.state.you.status, 'pending'));

    // Cat verifies her email, then opens the invite link again
    cat.room.leave();
    await waitFor(() => !ada.state.users.some((u) => u.userId === `jwt:${ID.cat}`), 'cat left');
    const cat2 = await connect(token(ID.cat, { email: 'cat@test.org', email_verified: true }));
    check('the verified invited email is let in with the invited role and pays its entry once', () => {
        assert.equal(cat2.state.you.status, 'approved');
        assert.equal(cat2.state.you.role, 'editor');
        const entries = ledger.calls.filter((c) => c.data.key?.endsWith(`:entry:jwt:${ID.cat}`));
        assert.equal(entries.length, 1);
    });


    console.log('\nMembership for the BeeStoon backend');

    const noKey = await members(`jwt:${ID.cat}`, null);
    const badKey = await members(`jwt:${ID.cat}`, 'x'.repeat(SERVICE_KEY.length));
    check('without the service key the route does not exist', () => {
        assert.equal(noKey.status, 404);
        assert.equal(badKey.status, 404);
    });

    const asCat = await members(`jwt:${ID.cat}`);
    const asDan = await members(`jwt:${ID.dan}`);
    const asAda = await members(`jwt:${ID.ada}`);
    check('approved members get their role, people still waiting are not members', () => {
        assert.deepEqual(asCat.json, { member: true, role: 'editor', owner: false, live: true });
        assert.equal(asAda.json.owner, true);
        assert.equal(asDan.status, 404);
    });

    ada.send('user:kick', { userId: `jwt:${ID.cat}` });
    await waitFor(async () => (await members(`jwt:${ID.cat}`)).status === 404, 'kicked');
    check('a kicked person stops being a member at once', () => assert.ok(true));


    console.log('\nCORS');

    const allowed = await fetch(`${SERVER}/sessions/mine`, { method: 'OPTIONS', headers: { Origin: SITE } });
    const other = await fetch(`${SERVER}/sessions/mine`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    const matchmakeOther = await fetch(`${SERVER}/matchmake/join/session`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    check('only the site origin is allowed, also for joining rooms', () => {
        assert.equal(allowed.headers.get('access-control-allow-origin'), SITE);
        assert.equal(other.headers.get('access-control-allow-origin'), null);
        assert.equal(matchmakeOther.headers.get('access-control-allow-origin'), null);
    });

    for (const u of [ada, dan, cat2]) {
        u.room.leave();
    }

    console.log(`\nAll ${passed} BeeStoon checks passed`);
}


main()
    .then(async () => {
        server.kill();
        fake.close();
        await sleep(300);
        await rm(storageDir, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(error);
        console.error('\n--- server log ---\n' + serverLog.slice(-4000));
        server.kill();
        fake.close();
        await rm(storageDir, { recursive: true, force: true });
        process.exit(1);
    });
