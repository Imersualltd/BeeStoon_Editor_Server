/*
 * Identity adapters
 * --------------------------------------------------
 * The room never looks at logins itself. It asks the
 * adapter chosen by the AUTH_PROVIDER env variable:
 *
 *   verify({ token, options }) -> { userId, name, email }
 *   (email may be null; it is only used for invites)
 *
 * and throws if the user is not allowed in.
 *
 *   AUTH_PROVIDER=dev   trusts the userId / name the
 *                       client sends (development only,
 *                       needs ALLOW_DEV_AUTH=true)
 *   AUTH_PROVIDER=jwt   verifies a signed token
 *                       (BeeStoon site or any other
 *                       login that issues JWTs)
 *
 * Switching login systems = changing env variables,
 * not the room code.
 */

import { devAdapter } from './dev.mjs';
import { jwtAdapter } from './jwt.mjs';


const ADAPTERS = {
    dev: devAdapter,
    jwt: jwtAdapter
};


let selected = null;


/*
 * Production (NODE_ENV=production) refuses settings that
 * are only safe for development: the dev identity, a JWT
 * without issuer/audience, wildcard CORS, placeholder
 * addresses. Returns the problems (empty = fine).
 */
export function productionProblems(env = process.env) {

    if (env.NODE_ENV !== 'production') {
        return [];
    }

    const problems = [];

    if ((env.AUTH_PROVIDER || 'dev').toLowerCase() !== 'jwt') {
        problems.push('AUTH_PROVIDER must be jwt');
    }

    if (env.ALLOW_DEV_AUTH === 'true') {
        problems.push('ALLOW_DEV_AUTH must not be true');
    }

    for (const name of ['JWT_ISSUER', 'JWT_AUDIENCE', 'CORS_ORIGINS', 'INVITE_BASE_URL']) {
        if (!env[name]) {
            problems.push(`${name} is required`);
        }
    }

    if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
        problems.push('JWT_SECRET must be at least 32 characters');
    }

    if (String(env.CORS_ORIGINS || '').split(',').some((o) => o.trim() === '*')) {
        problems.push('CORS_ORIGINS must list the site origins, not *');
    }

    if ((env.CREDITS_PROVIDER || 'local').toLowerCase() === 'beestoon' &&
        (!env.BEESTOON_API_URL || String(env.EDITOR_SERVICE_KEY || '').length < 32)) {
        problems.push('CREDITS_PROVIDER=beestoon needs BEESTOON_API_URL and EDITOR_SERVICE_KEY (32+ characters)');
    }

    if (env.CREDITS_ENABLED !== 'false' && (env.CREDITS_PROVIDER || 'local').toLowerCase() !== 'beestoon') {
        problems.push('credits must use CREDITS_PROVIDER=beestoon (or CREDITS_ENABLED=false)');
    }

    if (env.ASSET_DOWNLOAD_AUTH === 'open') {
        problems.push('ASSET_DOWNLOAD_AUTH=open is for development only');
    }

    for (const name of ['INVITE_BASE_URL', 'PUBLIC_BASE_URL', 'BEESTOON_API_URL']) {
        if (/example|localhost|127\.0\.0\.1|ngrok/i.test(env[name] || '')) {
            problems.push(`${name} points at a placeholder or local address`);
        }
    }

    return problems;
}


export function getAuthAdapter() {

    if (selected) {
        return selected;
    }

    const name = (process.env.AUTH_PROVIDER || 'dev').toLowerCase();

    const adapter = ADAPTERS[name];

    if (!adapter) {
        throw new Error(`Unknown AUTH_PROVIDER "${name}" (use dev or jwt)`);
    }

    // Fail at start-up, not on the first join
    adapter.check?.();

    console.log(`Identity provider: ${name}`);

    selected = adapter;

    return selected;
}
