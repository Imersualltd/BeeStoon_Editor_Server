/*
 * Error tracking (Sentry, EU region). Loaded before the server with
 * `node --import ./src/instrument.mjs src/index.mjs` (package.json start,
 * Dockerfile), so Express and HTTP are instrumented. Off unless SENTRY_DSN is
 * set. See the README (Error tracking).
 *
 * Sent: errors (Express routes, uncaught exceptions, unhandled rejections)
 * and a sample of request traces (SENTRY_TRACES_SAMPLE_RATE, 0.1 in
 * production).
 *
 * Kept out:
 * - the person: no user, IP address or location (NO_ADDRESS: without an
 *   address of its own an event gets the city of the address it came from);
 * - cookies, bodies, local variables, and headers that carry an address;
 * - console output, also as breadcrumbs: the logs name members and sessions;
 * - secrets in URLs: session keys, scene ids and AR link ids in paths, query
 *   strings, and any long random-looking token or e-mail address in a text.
 */
import * as Sentry from '@sentry/node';

const FILTERED = '[Filtered]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The query string of a URL or path
const QUERY = /((?:https?:\/\/|\/)[^\s?#"'<>]*\?)[^\s#"'<>]+/g;
// Path parts that are access keys: /sessions/<key>, /internal/sessions/<key>,
// /assets/<sceneId>/<file>, /ar/<id>
const PATH_SECRET = /(\/(?:sessions|assets|ar)\/)(?!mine\b|snapshots\b|:)[A-Za-z0-9_-]{8,}/g;
// A session key, ticket, scene or asset id anywhere in a text: 20+ letters,
// digits, - or _, with at least one digit and one letter (so ordinary words
// and names in messages stay readable)
const TOKEN = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;

export const NO_ADDRESS = { ip_address: '0.0.0.0' };

export const IDENTITY_TERMS = [
    'forwarded', '-ip', 'remote-', 'via', '-user', 'connecting-ip', 'email', 'cookie',
    // dev login (AUTH_PROVIDER=dev) names the person in a header
    'x-identity'
];

export function scrubText(text) {
    return text
        .replace(EMAIL, FILTERED)
        .replace(QUERY, `$1${FILTERED}`)
        .replace(PATH_SECRET, `$1${FILTERED}`)
        .replace(TOKEN, FILTERED);
}

// Sentry's own fields: its ids look like tokens but must stay (an event with a
// replaced event_id or trace_id is refused), stack frames stay readable
const KEEP = new Set([
    'event_id', 'trace_id', 'span_id', 'parent_span_id', 'segment_id', 'profile_id', 'replay_id',
    'release', 'dist', 'sdk', 'debug_meta', 'stacktrace', 'sample_rand'
]);

// A copy of value with secrets replaced.
export function scrub(value, key) {
    if (KEEP.has(key)) return value;
    if (typeof value === 'string') return scrubText(value);
    if (Array.isArray(value)) return value.map((v) => scrub(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
        return out;
    }
    return value;
}

export function scrubEvent(event) {
    const clean = scrub(event);
    clean.user = { ...NO_ADDRESS };
    if (clean.request) {
        delete clean.request.cookies;
        delete clean.request.query_string;
        delete clean.request.data;
    }
    return clean;
}

export function sentryEnvironment(env = process.env) {
    return env.SENTRY_ENVIRONMENT
        || (env.NODE_ENV === 'production' && env.EDITOR_DEPLOYMENT !== 'development' ? 'production' : 'development');
}

export function traceRate(env = process.env) {
    const set = Number(env.SENTRY_TRACES_SAMPLE_RATE);
    if (env.SENTRY_TRACES_SAMPLE_RATE && Number.isFinite(set)) return Math.min(1, Math.max(0, set));
    return sentryEnvironment(env) === 'production' ? 0.1 : 1.0;
}

export function sentryOptions(env = process.env) {
    return {
        dsn: env.SENTRY_DSN,
        environment: sentryEnvironment(env),
        // Render sets the deployed commit
        release: env.SENTRY_RELEASE || env.RENDER_GIT_COMMIT || undefined,
        tracesSampleRate: traceRate(env),
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { deny: IDENTITY_TERMS },
            httpBodies: [],
            urlQueryParams: false,
            stackFrameVariables: false,
            databaseQueryData: false,
            queues: false
        },
        // No console breadcrumbs (see above)
        integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Console'),
        beforeSend: scrubEvent,
        beforeBreadcrumb: (crumb) => scrub(crumb),
        beforeSendSpan: (span) => scrub(span),
        beforeSendLog: (log) => scrub(log)
    };
}

if (process.env.SENTRY_DSN) {
    try {
        Sentry.init(sentryOptions());
    } catch (error) {
        console.warn(`Sentry could not start; errors are only logged: ${error.message}`);
    }
}
