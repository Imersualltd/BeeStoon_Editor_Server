/*
 * Which browser origins may call this server
 * --------------------------------------------------
 * CORS_ORIGINS = comma-separated origins, e.g.
 *   https://beestoon.com,https://www.beestoon.com
 * Unset (development only): any origin, as before.
 * Production refuses to start without it (see
 * auth/index.mjs productionProblems).
 *
 * Used by every HTTP route and by the Colyseus
 * matchmaker (joining a room).
 */

export function allowedOrigins() {

    return String(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}


// The Access-Control-Allow-Origin value for a request's
// Origin header, or null (no header = browser blocks it)
export function originFor(origin) {

    const list = allowedOrigins();

    if (!list.length) {
        return origin || '*';
    }

    return origin && list.includes(origin) ? origin : null;
}


export function setCorsOrigin(req, res) {

    const value = originFor(req.headers.origin);

    res.setHeader('Vary', 'Origin');

    if (value) {
        res.setHeader('Access-Control-Allow-Origin', value);
    }
}
