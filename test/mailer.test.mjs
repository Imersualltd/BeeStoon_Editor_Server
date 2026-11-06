/*
 * Mailer test: invites are only reported as sent when
 * a mail service accepted them.
 *
 *   MAIL_PROVIDER=beestoon  goes through a stand-in for
 *     the BeeStoon API (/internal/editor/invite-email):
 *     accepted -> resolves, refused or unreachable ->
 *     throws with the reason
 *   MAIL_PROVIDER=log       never counts in BeeStoon mode
 *     (EDITOR_ACCESS=beestoon): nothing would be sent
 */

import assert from 'node:assert/strict';
import http from 'node:http';

let passed = 0;

function check(label) {
    passed++;
    console.log(`  ok  ${label}`);
}

const KEY = 's'.repeat(40);
const calls = [];
let answer = { status: 200, body: { accepted: true } };

const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
        calls.push({ url: req.url, key: req.headers['x-editor-service-key'], body: JSON.parse(raw || '{}') });
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
    });
});
await new Promise((resolve) => api.listen(0, resolve));

Object.assign(process.env, {
    EDITOR_ACCESS: 'beestoon',
    BEESTOON_API_URL: `http://127.0.0.1:${api.address().port}/`,
    EDITOR_SERVICE_KEY: KEY
});

const { mailerReady, sendInvite } = await import('../src/mailer.mjs');

console.log('\nMailer');

process.env.MAIL_PROVIDER = 'log';
assert.equal(mailerReady(), false);
await assert.rejects(sendInvite({ to: 'a@b.co', from: 'Ada', role: 'editor', link: 'x', sessionKey: 'abcdefgh1' }));
check('log provider never reports an invite as sent in BeeStoon mode');

process.env.MAIL_PROVIDER = 'beestoon';
assert.equal(mailerReady(), true);
await sendInvite({ to: 'guest@test.org', from: 'Ada', role: 'viewer', link: 'ignored', sessionKey: 'abcdefgh12' });
assert.deepEqual(calls.at(-1), {
    url: '/internal/editor/invite-email',
    key: KEY,
    body: { to: 'guest@test.org', fromName: 'Ada', role: 'viewer', sessionKey: 'abcdefgh12' }
});
check('beestoon provider resolves only after the API (Postmark) accepted, with the service key');

answer = { status: 502, body: { detail: { code: 'mail_rejected', message: 'The email service did not accept the invite' } } };
await assert.rejects(
    sendInvite({ to: 'guest@test.org', from: 'Ada', role: 'viewer', link: 'x', sessionKey: 'abcdefgh12' }),
    /did not accept/
);
check('a refused send throws with the reason (the room reports it as failed)');

api.close();
process.env.BEESTOON_API_URL = 'http://127.0.0.1:9';
await assert.rejects(
    sendInvite({ to: 'guest@test.org', from: 'Ada', role: 'viewer', link: 'x', sessionKey: 'abcdefgh12' }),
    /could not be reached/
);
check('an unreachable mail service throws');

process.env.EDITOR_SERVICE_KEY = 'short';
assert.equal(mailerReady(), false);
check('beestoon provider needs the service key');

console.log(`\nAll ${passed} checks passed`);
