/*
 * Helpers shared by the identity adapters
 */

// A readable, short display name
export function cleanName(value) {

    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f<>]/g, '')
        .trim()
        .slice(0, 40);
}


export const EMAIL_PATTERN = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}\.[^\s@,;<>"]{2,63}$/;


// Lower-case email address, or null
export function cleanEmail(value) {

    const email = String(value ?? '').trim().toLowerCase();

    return EMAIL_PATTERN.test(email) ? email : null;
}


export const USER_ID_PATTERN = /^[A-Za-z0-9_.@:|-]{1,128}$/;
