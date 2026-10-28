/*
 * "dev" identity adapter
 * --------------------------------------------------
 * Trusts whatever the client says it is:
 *
 *   client.join(..., { identity: { userId, name } })
 *
 * The PlayCanvas login cannot be checked by our
 * server, so this is NOT secure. It only runs when
 * ALLOW_DEV_AUTH=true and must never be enabled on
 * a production deployment.
 */

import { cleanEmail, cleanName, USER_ID_PATTERN } from './util.mjs';


export const devAdapter = {

    check() {

        if (process.env.ALLOW_DEV_AUTH !== 'true') {
            throw new Error(
                'AUTH_PROVIDER=dev needs ALLOW_DEV_AUTH=true ' +
                '(development only - use AUTH_PROVIDER=jwt in production)'
            );
        }
    },


    async verify({ options }) {

        const identity = options?.identity;

        const userId = String(identity?.userId ?? '');

        if (!USER_ID_PATTERN.test(userId)) {
            throw new Error('Missing or invalid userId');
        }

        return {
            userId: `dev:${userId}`,
            name: cleanName(identity?.name) || 'Guest',
            // Unchecked, like everything here (tests)
            email: cleanEmail(identity?.email)
        };
    }
};
