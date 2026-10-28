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
 *   MAIL_PROVIDER=log     prints the email to the server
 *                         log instead (development, tests)
 *   (not set)             no email invites: the client
 *                         opens the admin's own email app
 *
 * The room only calls mailerReady() and sendInvite();
 * switching email services = changing env variables
 * and this file, not the room code.
 */

const RESEND_URL = 'https://api.resend.com/emails';


function provider() {

    return String(process.env.MAIL_PROVIDER || '').toLowerCase();
}


// The server can send invites (sent to clients as
// features.emailInvites)
export function mailerReady() {

    const name = provider();

    if (name === 'log') {
        return true;
    }

    if (name === 'resend') {
        return !!(process.env.RESEND_API_KEY && process.env.INVITE_FROM);
    }

    return false;
}


/*
 * One invite email. Resolves when it was accepted,
 * throws with a short reason otherwise.
 *   { to, from, role, note, link }
 *   from = the admin's display name
 */
export async function sendInvite({ to, from, role, note, link }) {

    const subject = `${from} invited you to a Beestoon session`;

    const lines = [
        `${from} invited you to work together in a Beestoon session as ${role}.`,
        note ? `\n${note}\n` : '',
        `Join here: ${link}`,
        '',
        'Sign in with your BeeStoon account using this email address and you are let in straight away.'
    ];

    const text = lines.join('\n');

    const html =
        `<p>${escapeHtml(from)} invited you to work together in a Beestoon session as <b>${escapeHtml(role)}</b>.</p>` +
        (note ? `<p>${escapeHtml(note)}</p>` : '') +
        `<p><a href="${escapeHtml(link)}">Join the session</a></p>` +
        '<p>Sign in with your BeeStoon account using this email address and you are let in straight away.</p>';


    const name = provider();

    if (name === 'log') {

        console.log(`[mail] invite to ${to} (${role}): ${link}`);

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


function escapeHtml(value) {

    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}
