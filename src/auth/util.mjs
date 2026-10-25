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


export const USER_ID_PATTERN = /^[A-Za-z0-9_.@:|-]{1,128}$/;
