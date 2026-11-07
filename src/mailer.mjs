/*
 * Mailer - sends session invites by email
 * --------------------------------------------------
 * Chosen by the MAIL_PROVIDER env variable:
 *
 *   MAIL_PROVIDER=resend  sends through Resend
 *                         (https://resend.com):
 *                           RESEND_API_KEY  API key
 *                           INVITE_FROM     sender, e.g.
 *                             "Beestoon <invite@beestoon.com>"
 *                             (its domain must be verified
 *                             in Resend)
 *   MAIL_PROVIDER=beestoon  sends through BeeStoon's own
 *                         mail service (the API's Postmark
 *                         account): POST BEESTOON_API_URL
 *                         /internal/editor/invite-email with
 *                         EDITOR_SERVICE_KEY. The API answers
 *                         200 only once Postmark accepted the
 *                         message, and builds the link itself
 *                         (FRONTEND_URL/editor?session=<key>)
 *   MAIL_PROVIDER=log     prints the email to the server
 *                         log instead (development, tests).
 *                         Never with EDITOR_ACCESS=beestoon:
 *                         nothing is sent, so the room must
 *                         not report the invite as sent
 *   MAIL_PROVIDER=capture writes each email as a JSON file
 *                         to MAIL_CAPTURE_DIR and sends
 *                         nothing (local end-to-end tests)
 *   (not set)             no email invites: the client
 *                         opens the admin's own email app
 *
 * The room only calls mailerReady() and sendInvite();
 * switching email services = changing env variables
 * and this file, not the room code.
 */

import { accessChecked } from './editor-access.mjs';

const RESEND_URL = 'https://api.resend.com/emails';


function provider() {

    return String(process.env.MAIL_PROVIDER || '').toLowerCase();
}


// The server can send invites (sent to clients as
// features.emailInvites)
export function mailerReady() {

    const name = provider();

    if (name === 'log') {
        return !accessChecked();
    }

    if (name === 'beestoon') {
        return !!process.env.BEESTOON_API_URL && String(process.env.EDITOR_SERVICE_KEY || '').length >= 32;
    }

    if (name === 'capture') {
        return !!process.env.MAIL_CAPTURE_DIR;
    }

    if (name === 'resend') {
        return !!(process.env.RESEND_API_KEY && process.env.INVITE_FROM);
    }

    return false;
}


/*
 * One invite email: a standard text and a "Join
 * session" button. Resolves when it was accepted,
 * throws with a short reason otherwise.
 *   { to, from, role, link, sessionKey }
 *   from = the admin's display name
 */
export async function sendInvite({ to, from, role, link, sessionKey }) {

    const subject = `${from} invited you to a Beestoon session`;

    const text = [
        `${from} invited you to work together in a Beestoon session as ${role}.`,
        '',
        `Join the session: ${link}`,
        '',
        'Sign in with your BeeStoon account using this email address and you are let in straight away.'
    ].join('\n');

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">
            <p>${escapeHtml(from)} invited you to work together in a Beestoon session as <b>${escapeHtml(role)}</b>.</p>
            <p style="margin:24px 0">
                <a href="${escapeHtml(link)}"
                    style="display:inline-block;padding:12px 24px;border-radius:8px;background:#22c55e;
                    color:#ffffff;font-weight:bold;text-decoration:none">Join session</a>
            </p>
            <p style="color:#6b7280;font-size:13px">Sign in with your BeeStoon account using this email address
            and you are let in straight away. If the button does not work, open this link:<br>
            <a href="${escapeHtml(link)}" style="color:#16a34a">${escapeHtml(link)}</a></p>
        </div>`;


    const name = provider();

    if (name === 'log' && mailerReady()) {

        console.log(`[mail] invite to ${to} (${role}): ${link}`);

        return;
    }

    if (name === 'beestoon' && mailerReady()) {

        await sendThroughBeeStoon({ to, from, role, sessionKey });

        return;
    }

    if (name === 'capture' && mailerReady()) {

        const { mkdir, writeFile } = await import('node:fs/promises');
        const { randomUUID } = await import('node:crypto');
        const path = await import('node:path');

        await mkdir(process.env.MAIL_CAPTURE_DIR, { recursive: true });
        await writeFile(
            path.join(process.env.MAIL_CAPTURE_DIR, `${Date.now()}-${randomUUID()}.json`),
            JSON.stringify({ to, from, role, link, subject, text, html, at: new Date().toISOString() }, null, 2)
        );

        return;
    }

    if (name !== 'resend' || !mailerReady()) {
        throw new Error('Email invites are not set up on this server');
    }


    const response = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: process.env.INVITE_FROM,
            to: [to],
            subject,
            text,
            html
        })
    });

    if (!response.ok) {

        const detail = await response.text().catch(() => '');

        console.warn(`[mail] Resend refused ${to}: ${response.status} ${detail.slice(0, 200)}`);

        throw new Error('The email service did not accept it');
    }
}


// Resolves once BeeStoon's mail service accepted it
async function sendThroughBeeStoon({ to, from, role, sessionKey }) {

    const base = String(process.env.BEESTOON_API_URL).replace(/\/+$/, '');

    let response;

    try {
        response = await fetch(`${base}/internal/editor/invite-email`, {
            method: 'POST',
            headers: {
                'X-Editor-Service-Key': process.env.EDITOR_SERVICE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ to, fromName: String(from || '').slice(0, 80), role, sessionKey }),
            signal: AbortSignal.timeout(20000)
        });
    } catch (error) {
        console.warn(`[mail] BeeStoon mail service not reachable for ${to}: ${error.message}`);
        throw new Error('The email service could not be reached');
    }

    if (!response.ok) {

        const detail = await response.json().catch(() => ({}));

        console.warn(`[mail] BeeStoon refused ${to}: ${response.status} ${JSON.stringify(detail).slice(0, 200)}`);

        throw new Error(detail?.detail?.message || 'The email service did not accept it');
    }

    console.log(`[mail] invite to ${to} (${role}) accepted by the mail service`);
}


function escapeHtml(value) {

    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}
