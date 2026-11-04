/*
 * Session types and their limits
 * --------------------------------------------------
 * The creator picks a type when the session starts
 * (create option `sessionType`). Limits are checked on
 * the server; the client shows them from session:state
 * (`limits`).
 *
 *   people    approved + waiting people (one person in
 *             several browsers counts once)
 *   maxBytes  all model files in the session together
 *             (a model used twice counts once)
 *   fileBytes one model file
 *
 * Shown to people as Single / Multi Basic / Multi Pro
 * (ids stay single / basic / workshop).
 *
 * Numbers come from the cost plan (2026-10-29): model
 * files are served from storage, so the cost is mostly
 * data sent = size x people.
 */

const MB = 1024 * 1024;

export const SESSION_TYPES = {

    single: {
        label: 'Single',
        people: 1,
        maxBytes: 250 * MB,
        fileBytes: 50 * MB
    },

    basic: {
        label: 'Multi Basic',
        people: 8,
        maxBytes: 250 * MB,
        fileBytes: 50 * MB
    },

    workshop: {
        label: 'Multi Pro',
        people: 50,
        maxBytes: 500 * MB,
        fileBytes: 50 * MB
    }
};

// Upgrade order (session:upgrade only goes up this list)
export const SESSION_TYPE_ORDER = ['single', 'basic', 'workshop'];

// Credits per step up (single -> basic 1, basic -> workshop 1,
// single -> workshop 2)
export const UPGRADE_COST_PER_STEP = 1;


export function upgradeCost(from, to) {

    const steps = SESSION_TYPE_ORDER.indexOf(to) - SESSION_TYPE_ORDER.indexOf(from);

    return steps > 0 ? steps * UPGRADE_COST_PER_STEP : null;
}

// Older clients do not send a type
export const DEFAULT_SESSION_TYPE = 'basic';


export function sessionTypeOf(value) {

    return Object.hasOwn(SESSION_TYPES, value) ? value : DEFAULT_SESSION_TYPE;
}
