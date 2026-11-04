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
 *   JWT_ISSUER      expected "iss" (required in production)
 *   JWT_AUDIENCE    expected "aud" (required in production;
 *                   BeeStoon: "beestoon-editor")
 *   JWT_MAX_AGE_SECONDS  longest accepted token lifetime
 *                   (exp - iat), default 3600. Long-lived
 *                   site logins are refused.
 *
 * With BeeStoon, JWT_SECRET is EDITOR_JWT_SECRET (the
 * editor's own secret), never the site's signing key.
 *
 * Token claims used:
 *   sub   -> userId "jwt:<sub>" (required). BeeStoon puts
 *            the account id (UUID) here, never the email.
 *   name  -> display name (or preferred_username)
 *   email -> matched against email invites, ONLY when
 *            email_verified is exactly true
 *   exp   -> required
 *
 * The same "sub" in several browsers is one person
 * (ModelRoom keeps all their connections).
 */

import jwt from 'jsonwebtoken';

import { cleanEmail, cleanName, USER_ID_PATTERN } from './util.mjs';


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
            issuer: process.env.JWT_ISSUER || undefined,
            audience: process.env.JWT_AUDIENCE || undefined
        });

        if (typeof payload.exp !== 'number') {
            throw new Error('Token has no expiry');
        }

        const maxAge = Number(process.env.JWT_MAX_AGE_SECONDS) || 3600;
        const issuedAt = typeof payload.iat === 'number' ? payload.iat : Math.floor(Date.now() / 1000);

        if (payload.exp - issuedAt > maxAge) {
            throw new Error('Token lives too long for the editor');
        }

        const userId = String(payload.sub ?? '');

        if (!USER_ID_PATTERN.test(userId)) {
            throw new Error('Token has no valid "sub"');
        }

        return {
            userId: `jwt:${userId}`,
            name: cleanName(payload.name || payload.preferred_username) || 'User',
            // A missing claim is NOT verified
            email: payload.email_verified === true ? cleanEmail(payload.email) : null
        };
    }
};
