/*
 * Editor analytics backfill (one-off)
 * --------------------------------------------------
 * Sends what scene storage already knows about past
 * sessions to BeeStoon's analytics, so the Editor
 * dashboard shows history from before event capture:
 *
 *   records/<key>.json   owner, session type, name, members
 *                        and their roles, removed people
 *   <scene>/scene.json   saved sessions: attendees, versions
 *   <scene>/versions/*   which models were in each version
 *                        (name, size, who added it)
 *
 * Every event is marked backfilled and dated by the record
 * (a member's join time and a removal's time are unknown:
 * they use the session's creation time). Ids are derived
 * from the session and the item, so running this again
 * sends the same ids and the backend stores nothing twice.
 *
 * Needs the same settings as the server (SCENE_STORAGE and
 * its bucket, BEESTOON_API_URL, EDITOR_SERVICE_KEY) and
 * ANALYTICS_EVENTS_ENABLED=true on the BeeStoon backend.
 *
 *   node scripts/analytics-backfill.mjs            # report only
 *   node scripts/analytics-backfill.mjs --apply    # send
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { accountId, analyticsTransport, sessionRef } from '../src/analytics.mjs';
import { getSceneStorage } from '../src/scene-storage.mjs';
import { readRecord } from '../src/session-records.mjs';
import { loadVersion, sceneOfKey } from '../src/scene-versions.mjs';


const ROLES = new Set(['admin', 'editor', 'viewer']);


function id(...parts) {

    return createHash('sha256').update(['backfill', ...parts].join('|')).digest('hex').slice(0, 32);
}


function iso(value, fallback) {

    const t = Date.parse(value || '');

    return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}


export async function eventsOfSession(sessionKey) {

    const record = await readRecord(sessionKey);
    const scene = await sceneOfKey(sessionKey).catch(() => null);

    if (!record && !scene) {
        return [];
    }

    const session = sessionRef(sessionKey);
    const createdAt = iso(record?.createdAt || scene?.createdAt, new Date().toISOString());
    const owner = record?.owner || scene?.owner || null;
    const events = [];

    const add = (type, at, user, properties, ...key) => events.push({
        id: id(type, sessionKey, ...key), type, at, session, user: accountId(user),
        properties: { ...properties, backfilled: true }
    });

    add('editor_session_started', createdAt, owner?.userId, {
        kind: 'new',
        session_type: record?.sessionType || scene?.sessionType || 'basic',
        name: String(record?.sessionName || scene?.name || '').slice(0, 80) || undefined,
        scene: sessionRef(record?.sceneId || scene?.sceneId)
    });

    // Approved people and their (latest known) roles
    const members = { ...(scene?.attendees || {}), ...(record?.members || {}) };

    for (const [userId, member] of Object.entries(members)) {
        if (ROLES.has(member?.role)) {
            add('editor_member_joined', createdAt, userId,
                { role: member.role, via: userId === owner?.userId ? 'owner' : 'backfill' }, userId);
        }
    }

    for (const userId of new Set([...(record?.removed || []), ...(scene?.removed || [])])) {
        add('editor_member_removed', createdAt, userId, { role: 'unknown' }, userId);
    }

    if (record?.closedByAdmin) {
        add('editor_session_closed', iso(record.closedByAdmin, createdAt), null, {});
    }

    // Saved versions, oldest first: each save, and each model the
    // first time a version has it
    const seen = new Set();

    for (const summary of scene?.versions || []) {

        const at = iso(summary.createdAt, createdAt);

        add('editor_scene_saved', at, summary.savedBy?.userId, {
            kind: summary.auto ? 'auto' : 'manual', objects: summary.objectCount, bytes: summary.bytes
        }, summary.id);

        const version = await loadVersion(scene.sceneId, summary.id).catch(() => null);

        for (const object of version?.objects || []) {
            if (!object?.id || seen.has(object.id)) {
                continue;
            }
            seen.add(object.id);
            add('editor_model_added', at, object.addedBy, {
                object: String(object.id).slice(0, 64),
                name: String(object.name || '').slice(0, 120) || undefined,
                bytes: Number.isFinite(object.size) ? object.size : undefined,
                asset: object.assetId ? String(object.assetId).slice(0, 16) : undefined,
                origin: object.insertionId || object.source?.kind === 'beestoon' ? 'beestoon' : 'unknown'
            }, object.id);
        }
    }

    return events;
}


async function main() {

    const apply = process.argv.includes('--apply');
    const storage = getSceneStorage();
    const keys = (await storage.list('records'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/^.*\//, '').replace(/\.json$/, ''));

    const events = [];

    for (const key of keys) {
        events.push(...await eventsOfSession(key));
    }

    const counts = {};

    for (const e of events) {
        counts[e.type] = (counts[e.type] || 0) + 1;
    }

    console.log(`${keys.length} session record(s): ${events.length} event(s)`);
    console.table(counts);

    if (!apply) {
        console.log('Report only. Run with --apply to send them.');
        return;
    }

    if (!process.env.BEESTOON_API_URL || String(process.env.EDITOR_SERVICE_KEY || '').length < 32) {
        throw new Error('BEESTOON_API_URL and EDITOR_SERVICE_KEY are needed to send');
    }

    for (let i = 0; i < events.length; i += 100) {
        await analyticsTransport.send(events.slice(i, i + 100));
        console.log(`sent ${Math.min(i + 100, events.length)} / ${events.length}`);
    }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
