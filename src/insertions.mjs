/*
 * BeeStoon models added to a session
 * --------------------------------------------------
 * The BeeStoon API keeps one record per model on its
 * way into a session (an owner's existing model or a
 * finished generation). The room copies the file into
 * the session's own storage, adds the object for
 * everyone, saves the scene, and only then confirms:
 *
 *   POST /internal/editor/insertions/<id>/reserve
 *        { sessionKey, userId } -> { fileUrl, name, variant, modelId }
 *        only for the session it was asked for, only for
 *        its owner, who still has editor access
 *   POST /internal/editor/insertions/<id>/confirm
 *        { sessionKey, objectId }  (after the save)
 *
 * Until confirmed it stays pending on the API, so a
 * retry after a reload, reconnect or room switch finishes
 * it; the room never adds the same insertion twice.
 * Nobody else gets the owner's file: the session copy is
 * served like any session model (member tickets only).
 */

export const INSERTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


export class InsertionError extends Error {

    constructor(message, code = null) {
        super(message);
        this.code = code;
    }
}


async function api(path, body) {

    const base = String(process.env.BEESTOON_API_URL || '').replace(/\/+$/, '');
    const key = process.env.EDITOR_SERVICE_KEY || '';

    if (!base || key.length < 32) {
        throw new InsertionError('BeeStoon is not configured on this server', 'unavailable');
    }

    let response;

    try {
        response = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Editor-Service-Key': key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000)
        });
    } catch {
        throw new InsertionError('BeeStoon is not reachable. Try again in a moment.', 'unavailable');
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const detail = data?.detail;
        throw new InsertionError(
            (typeof detail === 'string' ? detail : detail?.message) || `BeeStoon answered ${response.status}`,
            detail?.code || (response.status === 404 ? 'not_found' : 'refused')
        );
    }

    return data;
}


// Replaced in tests
export const insertionApi = {

    reserve: (insertionId, sessionKey, userId) =>
        api(`/internal/editor/insertions/${insertionId}/reserve`, { sessionKey, userId }),

    confirm: (insertionId, sessionKey, objectId) =>
        api(`/internal/editor/insertions/${insertionId}/confirm`, { sessionKey, objectId })
};


// The owner's model file (a short-lived link), at most maxBytes
export async function downloadModel(url, maxBytes) {

    let response;

    try {
        response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    } catch {
        throw new InsertionError('The model file could not be downloaded. Try again.', 'download_failed');
    }

    if (!response.ok) {
        throw new InsertionError(`The model file could not be downloaded (${response.status}).`, 'download_failed');
    }

    const length = Number(response.headers.get('content-length') || 0);

    if (length > maxBytes) {
        throw new InsertionError(`This model is too big for this session (max ${Math.round(maxBytes / 1048576)} MB).`, 'too_big');
    }

    const body = Buffer.from(await response.arrayBuffer());

    if (body.length > maxBytes) {
        throw new InsertionError(`This model is too big for this session (max ${Math.round(maxBytes / 1048576)} MB).`, 'too_big');
    }

    return body;
}
