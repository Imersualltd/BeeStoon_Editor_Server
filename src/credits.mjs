/*
 * Credits
 * --------------------------------------------------
 * Every person has a credit balance (a "wallet").
 *
 *   Starting a session    the creator pays the session
 *                         type (single 1, basic 2,
 *                         workshop 3) plus the credit
 *                         pool they put in.
 *   Entering a session    each new attendee pays 1, once
 *                         per session (a second browser
 *                         or coming back is free). The
 *                         pool pays instead when the
 *                         admin let it cover entries and
 *                         it still has credits left.
 *   Model generation      the pool pays when the admin
 *                         let it cover models, else the
 *                         person (spendForModel, for the
 *                         BeeStoon model generation).
 *
 * Re-opening a saved session costs nothing; its pool
 * is saved with it (scene.credits).
 *
 * Until the BeeStoon accounts exist, wallets live in
 * the scene storage (wallets/<user>.json) and a new
 * person starts with CREDITS_START credits (default
 * 20). CREDITS_ENABLED=false turns all of this off.
 */

import { queued, readJson, writeJson } from './scene-versions.mjs';
import { identify } from './my-sessions.mjs';


export const SESSION_COSTS = {
    single: 1,
    basic: 2,
    workshop: 3
};

export const ENTRY_COST = 1;

export const MAX_POOL = 10000;


export function creditsEnabled() {

    return process.env.CREDITS_ENABLED !== 'false';
}


function startBalance() {

    const value = Number(process.env.CREDITS_START);

    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 20;
}


function walletKey(userId) {

    return `wallets/${Buffer.from(String(userId)).toString('base64url')}.json`;
}


async function readWallet(userId) {

    return (await readJson(walletKey(userId))) || {
        userId,
        balance: startBalance(),
        history: []
    };
}


export async function balanceOf(userId) {

    if (!creditsEnabled()) {
        return null;
    }

    return (await readWallet(userId)).balance;
}


/*
 * Take `amount` credits from a person. Throws an error
 * with userMessage when the balance is too low.
 * Returns the new balance.
 */
export function charge(userId, amount, reason) {

    return queued(walletKey(userId), async () => {

        const wallet = await readWallet(userId);

        if (wallet.balance < amount) {

            const error = new Error('not enough credits');

            error.userMessage =
                `You need ${amount} credit${amount === 1 ? '' : 's'} for this ` +
                `(you have ${wallet.balance}).`;

            error.balance = wallet.balance;

            throw error;
        }

        wallet.balance -= amount;

        addHistory(wallet, -amount, reason);

        await writeJson(walletKey(userId), wallet);

        return wallet.balance;
    });
}


// Give credits back (e.g. a refund)
export function refund(userId, amount, reason) {

    return queued(walletKey(userId), async () => {

        const wallet = await readWallet(userId);

        wallet.balance += amount;

        addHistory(wallet, amount, reason);

        await writeJson(walletKey(userId), wallet);

        return wallet.balance;
    });
}


function addHistory(wallet, amount, reason) {

    wallet.history.push({ amount, reason: String(reason || ''), at: new Date().toISOString() });

    // Keep the last 100
    wallet.history = wallet.history.slice(-100);
}


/*
 * The pool the creator sets up, from the create options
 *   creditPool      credits put in (0 ... MAX_POOL)
 *   poolForEntry    the pool pays attendees' entry
 *   poolForModels   the pool pays model generation
 */
export function poolFromOptions(options) {

    const total = Math.floor(Number(options?.creditPool));

    return {
        total: Number.isFinite(total) ? Math.max(0, Math.min(MAX_POOL, total)) : 0,
        left: 0,
        forEntry: options?.poolForEntry === true,
        forModels: options?.poolForModels === true
    };
}


// ==================================================
// HTTP: GET /credits/mine  -> { enabled, balance,
//   sessionCosts, entryCost }
// ==================================================

export function registerCreditRoutes(app) {

    app.use('/credits', (req, res, next) => {

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-Identity, ngrok-skip-browser-warning'
        );

        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }

        next();
    });


    app.get('/credits/mine', async (req, res) => {

        try {

            const me = await identify(req, res);

            if (!me) {
                return;
            }

            res.setHeader('Cache-Control', 'no-store');

            res.json({
                enabled: creditsEnabled(),
                balance: await balanceOf(me.userId),
                sessionCosts: SESSION_COSTS,
                entryCost: ENTRY_COST
            });

        } catch (error) {

            console.error('GET /credits/mine failed:', error);

            res.status(500).send('Could not read your credits');
        }
    });
}
