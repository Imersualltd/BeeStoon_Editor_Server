/*
 * Editor analytics
 * --------------------------------------------------
 * What people do in editor sessions, sent to BeeStoon's
 * analytics store (POST {BEESTOON_API_URL}/internal/
 * analytics/editor-events, EDITOR_SERVICE_KEY), where the
 * admin dashboard reads it (Editor section).
 *
 * Off unless ANALYTICS_EVENTS_ENABLED=true and BeeStoon is
 * configured (BEESTOON_API_URL, EDITOR_SERVICE_KEY). The
 * backend has its own switch of the same name and drops
 * everything while that one is off.
 *
 * Fire and forget: track() only adds to a queue in memory
 * and never throws, so a message handler never waits for
 * analytics and never fails because of it. The queue is
 * sent every FLUSH_MS (at most BATCH events per request),
 * retried a few times, then dropped. It is bounded, so a
 * BeeStoon outage cannot use up the server's memory.
 * Render restarts this process often (deploys, a free
 * instance sleeping), so events go out as they happen and
 * the room flushes once more when it ends (onDispose).
 *
 * What is sent, on purpose:
 *   - session: sha256(session key), first 16 hex. The key
 *     itself (the share link) never leaves this server.
 *   - user: the BeeStoon account UUID (from "jwt:<uuid>");
 *     development identities send none.
 *   - properties: counts, sizes, roles, tool and format
 *     names, object ids made by the editor, the model's
 *     display name and the session name.
 * Never: emails, invite links, tickets, file contents,
 * transforms, IP addresses.
 *
 * Every event has a random id; the backend stores a resent
 * batch once.
 */

import { createHash, randomUUID } from 'node:crypto';


const FLUSH_MS = 2000;
const BATCH = 100;
const MAX_QUEUE = 5000;
const MAX_ATTEMPTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let queue = [];
let timer = null;
let sending = null;
let dropped = 0;


export function analyticsEnabled(env = process.env) {

    const on = ['1', 'true', 'yes', 'on'].includes(String(env.ANALYTICS_EVENTS_ENABLED || '').trim().toLowerCase());

    return on && !!env.BEESTOON_API_URL && String(env.EDITOR_SERVICE_KEY || '').length >= 32;
}


// The reference the backend groups a session's events by
export function sessionRef(sessionKey) {

    return sessionKey
        ? createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 16)
        : null;
}


// BeeStoon account UUID of an editor identity ("jwt:<uuid>"; a
// development identity only when its id is a UUID, for tests), or null
export function accountId(userId) {

    const value = String(userId || '').replace(/^(jwt|dev):/, '');

    return UUID.test(value) ? value.toLowerCase() : null;
}


// Replaced in tests
export const analyticsTransport = {

    async send(events) {

        const base = String(process.env.BEESTOON_API_URL || '').replace(/\/+$/, '');

        const response = await fetch(`${base}/internal/analytics/editor-events`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Editor-Service-Key': process.env.EDITOR_SERVICE_KEY || ''
            },
            body: JSON.stringify({ events }),
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`BeeStoon answered ${response.status}`);
        }
    }
};


/*
 * Queue one event.
 *   type      editor_* (the backend keeps a list of the types it accepts)
 *   session   the session key (hashed here)
 *   user      editor user id ("jwt:<uuid>") the event is about
 *   at        when it happened (ms or Date), default now
 *   ...props  the event's properties
 */
export function track(type, { session = null, user = null, at = null, ...props } = {}) {

    try {

        if (!analyticsEnabled()) {
            return;
        }

        const properties = {};

        for (const [key, value] of Object.entries(props)) {
            // "by": the person who did it to `user` (an admin), as an account id too
            const clean = key === 'by' ? accountId(value) : value;
            if (clean !== undefined && clean !== null) {
                properties[key] = clean;
            }
        }

        queue.push({
            id: randomUUID().replace(/-/g, ''),
            type,
            at: new Date(at ?? Date.now()).toISOString(),
            session: sessionRef(session),
            user: accountId(user),
            properties,
            attempts: 0
        });

        if (queue.length > MAX_QUEUE) {
            dropped += queue.length - MAX_QUEUE;
            queue.splice(0, queue.length - MAX_QUEUE);
        }

        schedule(FLUSH_MS);

    } catch (error) {
        console.error(`[analytics] could not queue ${type}: ${error.message}`);
    }
}


function schedule(ms) {

    if (!timer) {
        timer = setTimeout(() => {
            timer = null;
            flushAnalytics().catch(() => {});
        }, ms);
        timer.unref?.();
    }
}


/*
 * Send what is queued. Resolves when the queue is empty or
 * a request failed (the rest waits for the next try).
 */
export function flushAnalytics() {

    if (sending) {
        return sending;
    }

    sending = (async () => {

        while (queue.length) {

            const batch = queue.slice(0, BATCH);

            try {

                await analyticsTransport.send(batch.map(({ attempts, ...event }) => event));

                queue = queue.slice(batch.length);

            } catch (error) {

                for (const event of batch) {
                    event.attempts++;
                }

                const kept = batch.filter((event) => event.attempts < MAX_ATTEMPTS);

                dropped += batch.length - kept.length;

                queue = [...kept, ...queue.slice(batch.length)];

                console.warn(`[analytics] ${batch.length} event(s) not sent yet (${error.message})` +
                    (dropped ? `; ${dropped} dropped so far` : ''));

                if (queue.length) {
                    schedule(FLUSH_MS * 5);
                }

                return;
            }
        }
    })().finally(() => {
        sending = null;
    });

    return sending;
}


// A flush that gives up after `ms` (shutting down must not hang)
export function flushAnalyticsWithin(ms = 3000) {

    return Promise.race([
        flushAnalytics().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, ms).unref?.())
    ]);
}


// Testing helpers
export function analyticsQueue() {

    return queue.map(({ attempts, ...event }) => event);
}


export function resetAnalytics() {

    queue = [];
    dropped = 0;
    clearTimeout(timer);
    timer = null;
}
