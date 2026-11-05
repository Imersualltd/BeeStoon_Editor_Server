/*
 * Existing data -> BeeStoon identities: inventory is read only,
 * test wallets are listed apart and never written, a mapping
 * changes only the ids it names, backs files up first, keeps old
 * files, refuses bad targets and is safe to run twice.
 *
 *   node test/identity-migration.test.mjs
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'beestoon-identity-test-'));
process.env.SCENE_STORAGE = 'local';
process.env.SCENE_LOCAL_DIR = dir;

const { getSceneStorage } = await import('../src/scene-storage.mjs');
const { applyMapping, inventory, kindOf } = await import('../src/identity-migration.mjs');

const storage = getSceneStorage();
const put = (key, value) => storage.put(key, Buffer.from(JSON.stringify(value)));
const read = async (key) => JSON.parse((await storage.get(key)).toString());
const b64 = (id) => Buffer.from(id).toString('base64url');

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok  ${label}`); };

const ADA_OLD = 'dev:browser-abc123', BOB_OLD = 'jwt:bob@example.org';
const ADA = 'jwt:11111111-1111-4111-8111-111111111111', BOB = 'jwt:22222222-2222-4222-8222-222222222222';

await put('keys/studio-key-01.json', { sceneId: 'sceneAAAAAAAAAAAAAAAAAAAA' });
await put('sceneAAAAAAAAAAAAAAAAAAAA/scene.json', {
    sceneId: 'sceneAAAAAAAAAAAAAAAAAAAA', sessionKey: 'studio-key-01', name: 'Studio', sessionType: 'basic',
    owner: { userId: ADA_OLD, name: 'Ada' },
    attendees: { [ADA_OLD]: { name: 'Ada', role: 'admin' }, [BOB_OLD]: { name: 'Bob', role: 'editor' }, 'dev:as-cat': { name: 'Cat', role: 'viewer' } },
    versions: [{ id: 'v1', savedBy: { userId: BOB_OLD, name: 'Bob' } }],
    credits: { total: 5, left: 3 }
});
await put('sceneAAAAAAAAAAAAAAAAAAAA/versions/v1.json', { id: 'v1', savedBy: { userId: BOB_OLD }, objects: [{ id: 'chair', addedBy: ADA_OLD, assignedTo: BOB_OLD }] });
await storage.put('sceneAAAAAAAAAAAAAAAAAAAA/blobs/' + 'a'.repeat(64) + '.glb', Buffer.alloc(2048));
await put(`users/${b64(ADA_OLD)}/scenes.json`, [{ sceneId: 'sceneAAAAAAAAAAAAAAAAAAAA', owner: true }]);
await put(`users/${b64(BOB_OLD)}/scenes.json`, [{ sceneId: 'sceneAAAAAAAAAAAAAAAAAAAA', owner: false }]);
await put(`wallets/${b64(ADA_OLD)}.json`, { userId: ADA_OLD, balance: 17, history: [{ amount: -2 }] });

const walletBefore = await readFile(path.join(dir, 'wallets', `${b64(ADA_OLD)}.json`));

check('ids are classified', () => {
    assert.equal(kindOf(ADA), 'beestoon-account');
    assert.equal(kindOf(BOB_OLD), 'site-email');
    assert.equal(kindOf(ADA_OLD), 'test-browser');
    assert.equal(kindOf('dev:as-cat'), 'test-name');
});

const inv = await inventory(storage);
check('inventory lists sessions, people needing input, and test wallets apart', () => {
    assert.equal(inv.scenes.length, 1);
    assert.equal(inv.scenes[0].storedBytes, 2048);
    assert.deepEqual(inv.scenes[0].pool, { total: 5, left: 3 });
    assert.deepEqual(inv.people.filter((p) => p.needsInput).map((p) => p.userId).sort(), [ADA_OLD, 'dev:as-cat'].sort());
    assert.deepEqual(inv.wallets, [{ userId: ADA_OLD, kind: 'test-browser', balance: 17, entries: 1 }]);
});

const bad = await applyMapping(storage, { [ADA_OLD]: 'jwt:ada@example.org', 'dev:nobody': ADA });
check('a target that is not jwt:<UUID>, or an id not in the data, is refused', () => {
    assert.equal(bad.ok, false);
    assert.equal(bad.problems.length, 2);
});

const dry = await applyMapping(storage, { [ADA_OLD]: ADA, [BOB_OLD]: BOB });
const ownerAfterDryRun = (await read('sceneAAAAAAAAAAAAAAAAAAAA/scene.json')).owner.userId;
check('a dry run lists the changes and writes nothing', () => {
    assert.ok(dry.ok && dry.changes.length >= 3);
    assert.equal(ownerAfterDryRun, ADA_OLD);
});

const done = await applyMapping(storage, { [ADA_OLD]: ADA, [BOB_OLD]: BOB }, { apply: true, backupPrefix: 'migration-backup/20261105000000' });
const scene = await read('sceneAAAAAAAAAAAAAAAAAAAA/scene.json');
const version = await read('sceneAAAAAAAAAAAAAAAAAAAA/versions/v1.json');
check('only the mapped ids change, everywhere they appear', () => {
    assert.ok(done.applied);
    assert.equal(scene.owner.userId, ADA);
    assert.deepEqual(Object.keys(scene.attendees).sort(), [ADA, BOB, 'dev:as-cat'].sort());
    assert.equal(scene.versions[0].savedBy.userId, BOB);
    assert.deepEqual(version.objects[0], { id: 'chair', addedBy: ADA, assignedTo: BOB });
});

const backup = await read('migration-backup/20261105000000/sceneAAAAAAAAAAAAAAAAAAAA/scene.json');
const oldList = await read(`users/${b64(ADA_OLD)}/scenes.json`);
const newList = await read(`users/${b64(ADA)}/scenes.json`);
check('every changed file was backed up first; old lists stay; the new person gets the session', () => {
    assert.equal(backup.owner.userId, ADA_OLD);
    assert.deepEqual(oldList, [{ sceneId: 'sceneAAAAAAAAAAAAAAAAAAAA', owner: true }]);
    assert.deepEqual(newList, [{ sceneId: 'sceneAAAAAAAAAAAAAAAAAAAA', owner: true }]);
});

const walletAfter = await readFile(path.join(dir, 'wallets', `${b64(ADA_OLD)}.json`));
const modelKept = await stat(path.join(dir, 'sceneAAAAAAAAAAAAAAAAAAAA', 'blobs', 'a'.repeat(64) + '.glb')).then(() => true, () => false);
check('test wallets are never written and nothing is deleted', () => {
    assert.ok(walletBefore.equals(walletAfter));
    assert.ok(modelKept);
});

const again = await applyMapping(storage, { [ADA_OLD]: ADA }, { apply: true, backupPrefix: 'migration-backup/20261105000001' });
check('running it again is refused for ids that are gone, so nothing is mapped twice', () => {
    assert.equal(again.ok, false);
    assert.match(again.problems[0], /not found/);
});

await rm(dir, { recursive: true, force: true });
console.log(`\nAll ${passed} identity migration checks passed`);
