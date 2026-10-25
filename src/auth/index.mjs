/*
 * Identity adapters
 * --------------------------------------------------
 * The room never looks at logins itself. It asks the
 * adapter chosen by the AUTH_PROVIDER env variable:
 *
 *   verify({ token, options }) -> { userId, name }
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
