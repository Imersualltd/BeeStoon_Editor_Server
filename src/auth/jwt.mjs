/*
 * "jwt" identity adapter
 * --------------------------------------------------
 * The website (e.g. BeeStoon) signs a token for the
 * logged-in user and puts it in the editor link.
 * The client passes it as the Colyseus auth token
 * (client.auth.token = ...).
 *
 * Env variables:
 *   JWT_SECRET      shared secret  (HS256)  or
 *   JWT_PUBLIC_KEY  PEM public key (RS256)
 *   JWT_ISSUER      expected "iss" (optional)
 *
 * Token claims used:
 *   sub   -> userId (required)
 *   name  -> display name (or preferred_username)
 */

import jwt from 'jsonwebtoken';

import { cleanName, USER_ID_PATTERN } from './util.mjs';


function keyAndAlgorithms() {

    if (process.env.JWT_PUBLIC_KEY) {
        return {
            key: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
            algorithms: ['RS256']
        };
    }

    if (process.env.JWT_SECRET) {
        return { key: process.env.JWT_SECRET, algorithms: ['HS256'] };
    }

    return null;
}


export const jwtAdapter = {

    check() {

        if (!keyAndAlgorithms()) {
            throw new Error('AUTH_PROVIDER=jwt needs JWT_SECRET or JWT_PUBLIC_KEY');
        }
    },


    async verify({ token, options }) {

        const raw = token || options?.token;

        if (!raw || typeof raw !== 'string') {
            throw new Error('Missing login token');
        }

        const { key, algorithms } = keyAndAlgorithms();

        const payload = jwt.verify(raw, key, {
            algorithms,
            issuer: process.env.JWT_ISSUER || undefined
        });

        const userId = String(payload.sub ?? '');

        if (!USER_ID_PATTERN.test(userId)) {
            throw new Error('Token has no valid "sub"');
        }

        return {
            userId: `jwt:${userId}`,
            name: cleanName(payload.name || payload.preferred_username) || 'User'
        };
    }
};
