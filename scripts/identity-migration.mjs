#!/usr/bin/env node
/*
 * Existing editor data -> BeeStoon identities (see src/identity-migration.mjs)
 * Uses the same storage settings as the server (SCENE_STORAGE, S3_*, SCENE_LOCAL_DIR).
 *
 *   node scripts/identity-migration.mjs inventory [--json]
 *       read only: saved sessions, the ids in them, test wallets
 *   node scripts/identity-migration.mjs propose <accounts.csv>
 *       accounts.csv = "email,account_id" exported from BeeStoon; prints a
 *       mapping for jwt:<email> ids only. Review it before using it.
 *   node scripts/identity-migration.mjs map <mapping.json>            dry run
 *   node scripts/identity-migration.mjs map <mapping.json> --apply    backs up, then writes
 *       mapping.json = { "<old id>": "jwt:<account UUID>", ... }
 */

import { readFile } from 'node:fs/promises';

import { applyMapping, inventory } from '../src/identity-migration.mjs';
import { getSceneStorage } from '../src/scene-storage.mjs';

const [command, file, flag] = process.argv.slice(2);
const storage = getSceneStorage();

if (command === 'inventory') {
    const result = await inventory(storage);
    if (file === '--json') {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`Saved sessions: ${result.scenes.length}`);
        for (const s of result.scenes) {
            console.log(`  ${s.sessionKey}  "${s.name}"  ${s.sessionType}  owner ${s.owner.userId} (${s.owner.kind})  ` +
                `${s.attendees} attendee(s), ${s.versions} version(s), ${(s.storedBytes / 1048576).toFixed(1)} MB`);
        }
        console.log(`People: ${result.people.length}`);
        for (const p of result.people) {
            console.log(`  ${p.userId}  ${p.kind}${p.needsInput ? '  NEEDS YOUR INPUT' : ''}  names: ${p.names.join(', ')}  ` +
                `sessions: ${p.sessions} (owns ${p.owns})`);
        }
        console.log(`Test wallets (not carried into BeeStoon): ${result.wallets.length}`);
        for (const w of result.wallets) {
            console.log(`  ${w.userId}  ${w.kind}  balance ${w.balance}  ${w.entries} entries`);
        }
    }
} else if (command === 'propose' && file) {
    const accounts = new Map((await readFile(file, 'utf8')).split(/\r?\n/).slice(1)
        .map((line) => line.split(',').map((v) => v.trim())).filter((r) => r.length >= 2)
        .map(([email, id]) => [email.toLowerCase(), id]));
    const { people } = await inventory(storage);
    const proposal = {};
    for (const p of people.filter((x) => x.kind === 'site-email')) {
        const id = accounts.get(p.userId.slice(4).toLowerCase());
        if (id) proposal[p.userId] = `jwt:${id}`;
    }
    console.log(JSON.stringify(proposal, null, 2));
} else if (command === 'map' && file) {
    const map = JSON.parse(await readFile(file, 'utf8'));
    const apply = flag === '--apply';
    const backupPrefix = `migration-backup/${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const result = await applyMapping(storage, map, { apply, backupPrefix });
    if (!result.ok) {
        console.error('Mapping refused:\n  ' + result.problems.join('\n  '));
        process.exit(1);
    }
    console.log(`${apply ? 'Changed' : 'Would change'} ${result.changes.length} file(s):\n  ${result.changes.join('\n  ')}`);
    if (apply) console.log(`Backups: ${backupPrefix}/`);
} else {
    console.error('Usage: identity-migration.mjs inventory [--json] | propose <accounts.csv> | map <mapping.json> [--apply]');
    process.exit(2);
}
