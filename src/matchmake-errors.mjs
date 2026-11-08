/*
 * Matchmaking answers that survive the hosting proxy
 * --------------------------------------------------
 * Colyseus answers a failed join / create with the HTTP
 * status of its error code: 520 no such room type, 521 no
 * room with that key, 522 unknown room id, 523 unhandled,
 * 524 seat expired, 525 auth failed, 526 application
 * error. Render serves this app through Cloudflare, which
 * keeps 520-527 for its own "origin is down" pages: it
 * replaces such an answer with "error code: 52x" as plain
 * text, without our CORS headers. The browser then only
 * sees "Failed to fetch".
 *
 * That kept saved sessions on Connecting: reopening one
 * starts with join, the server answered 521 ("not open,
 * create it"), the client never saw the code, never
 * created the room, and retried the join forever. New
 * sessions start with create and were not affected.
 *
 * The same errors are answered with ordinary statuses
 * here; the editor knows both (network-manager patch):
 *   520 -> 501   521 -> 404   522 -> 404   523 -> 500
 *   524 -> 408   525 -> 401   526 -> 500   527 -> 500
 */

import { ServerError } from 'colyseus';


export const PROXY_SAFE_STATUS = {
    520: 501,
    521: 404,
    522: 404,
    523: 500,
    524: 408,
    525: 401,
    526: 500,
    527: 500
};


export function proxySafeError(error) {

    const status = PROXY_SAFE_STATUS[error?.code];

    return status ? new ServerError(status, error.message) : error;
}


export function installProxySafeMatchmaking(controller) {

    const invoke = controller.invokeMethod.bind(controller);

    controller.invokeMethod = async (method, roomName, clientOptions = {}, authOptions) => {

        try {
            return await invoke(method, roomName, clientOptions, authOptions);
        } catch (error) {

            const safe = proxySafeError(error);

            // Never the options themselves (identity, tokens)
            if (safe.code !== 404 || method !== 'join') {
                console.log(
                    `[matchmake] ${method} ${String(roomName).slice(0, 32)} ` +
                    `${String(clientOptions?.sessionKey || '').slice(0, 64)}: ${error.code} ${error.message}` +
                    (safe !== error ? ` (answered ${safe.code})` : '')
                );
            }

            throw safe;
        }
    };
}
