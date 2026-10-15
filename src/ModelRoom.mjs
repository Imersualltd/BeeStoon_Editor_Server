/*
 * ModelRoom
 * --------------------------------------------------
 * Many shared GLB objects, each with its own id and
 * transform, relayed between everyone in the room.
 *
 * Messages (same protocol as network-manager.mjs):
 *
 *   client -> server
 *     'object:add'        { id, name, dataUrl, transform? }
 *     'object:transform'  { id, position, rotation, scale }
 *     'object:remove'     { id }
 *     'sync-request'      { have?: [id, ...] }
 *
 *   server -> client
 *     'object:list'       { serverId, ids: [id, ...] }
 *     'object:add'        { id, name, dataUrl, transform }
 *     'object:transform'  { id, position, rotation, scale }
 *     'object:remove'     { id }
 *     'object:rejected'   { id, reason }   (sender only)
 *
 * sync-request: the server answers with the full id
 * list, then 'object:add' for every object the client
 * does not already have ("have"), then every transform.
 * So a reconnect does not download the models again.
 *
 * serverId changes on every server start. When it
 * changes, clients know the server lost its memory and
 * re-send their own objects.
 *
 * There is no limit on the NUMBER of objects. The limit
 * is memory: all models together may use at most
 * MAX_ROOM_BYTES (env MAX_ROOM_MB, default 250 MB).
 * A model that does not fit is rejected and stays only
 * on the sender's screen.
 *
 * Objects live only in memory; a server restart wipes
 * them.
 */

import { randomUUID } from 'node:crypto';
import { Room } from 'colyseus';


// Keep in sync with MAX_FILE_SIZE in the client
// (10 MB file -> ~13.4 MB base64 data URL).
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;

// Total size of all models in one room. Render's free
// plan has 512 MB RAM for everything, so stay well below.
const MAX_ROOM_BYTES =
    (Number(process.env.MAX_ROOM_MB) || 250) * 1024 * 1024;

// Seconds a dropped player keeps their seat
const RECONNECT_WINDOW = 20;

// Client-made ids (crypto.randomUUID or similar)
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// New for every server start (see header)
const SERVER_ID = randomUUID();


export class ModelRoom extends Room {

    // Keep the room (and the shared objects) alive
    // when the last player leaves.
    autoDispose = false;

    maxClients = 50;


    onCreate() {

        // id -> { id, name, dataUrl, transform }
        // Map keeps insertion order = import order.
        this.objects = new Map();

        this.totalBytes = 0;


        this.onMessage('object:add', (client, data) => {

            if (!isValidAsset(data)) {

                console.warn(
                    `[${this.roomId}] rejected object from ${client.sessionId}`
                );

                return;
            }


            const previous = this.objects.get(data.id);
            const freed = previous ? previous.dataUrl.length : 0;

            if (this.totalBytes - freed + data.dataUrl.length > MAX_ROOM_BYTES) {

                console.warn(
                    `[${this.roomId}] room is full, rejected "${data.name}"`
                );

                client.send('object:rejected', {
                    id: data.id,
                    reason: 'The room is full (server memory limit) - this model stays only on your screen'
                });

                return;
            }


            const object = {
                id: data.id,
                name: data.name,
                dataUrl: data.dataUrl,
                transform: isValidTransform(data.transform)
                    ? pickTransform(data.transform)
                    : null
            };

            this.objects.set(object.id, object);

            this.totalBytes += object.dataUrl.length - freed;


            console.log(
                `[${this.roomId}] add "${object.name}" ` +
                `(${Math.round(object.dataUrl.length / 1024)} KB) ` +
                `from ${client.sessionId} - ${this.objects.size} objects, ` +
                `${Math.round(this.totalBytes / 1024 / 1024)} MB`
            );


            // Sender already shows it locally
            this.broadcast('object:add', object, { except: client });
        });


        this.onMessage('object:transform', (client, data) => {

            if (!isValidId(data?.id) || !isValidTransform(data)) {
                return;
            }


            const object = this.objects.get(data.id);

            if (!object) {
                return;
            }


            object.transform = pickTransform(data);

            this.broadcast(
                'object:transform',
                { id: object.id, ...object.transform },
                { except: client }
            );
        });


        this.onMessage('object:remove', (client, data) => {

            const object = isValidId(data?.id) ? this.objects.get(data.id) : null;

            if (!object) {
                return;
            }


            this.objects.delete(object.id);

            this.totalBytes -= object.dataUrl.length;


            console.log(
                `[${this.roomId}] remove "${object.name}" by ${client.sessionId} ` +
                `- ${this.objects.size} objects left`
            );


            this.broadcast('object:remove', { id: object.id }, { except: client });
        });


        this.onMessage('sync-request', (client, data) => {

            const have = new Set(
                Array.isArray(data?.have)
                    ? data.have.filter(isValidId)
                    : []
            );


            client.send('object:list', {
                serverId: SERVER_ID,
                ids: [...this.objects.keys()]
            });


            for (const object of this.objects.values()) {

                if (have.has(object.id)) {

                    // Client has the model: only the pose
                    if (object.transform) {
                        client.send('object:transform', { id: object.id, ...object.transform });
                    }

                } else {

                    // transform travels inside the add
                    client.send('object:add', object);
                }
            }
        });


        console.log(
            `[${this.roomId}] room created ` +
            `(memory limit ${Math.round(MAX_ROOM_BYTES / 1024 / 1024)} MB)`
        );
    }


    onJoin(client) {

        console.log(
            `[${this.roomId}] join ${client.sessionId} ` +
            `(${this.clients.length} online)`
        );
    }


    // Unexpected disconnect (bad network, phone
    // locked ...) - hold the seat for a while.
    onDrop(client) {

        console.log(
            `[${this.roomId}] drop ${client.sessionId}, ` +
            `waiting ${RECONNECT_WINDOW}s`
        );

        this.allowReconnection(client, RECONNECT_WINDOW);
    }


    onReconnect(client) {

        console.log(
            `[${this.roomId}] reconnect ${client.sessionId}`
        );
    }


    onLeave(client) {

        console.log(
            `[${this.roomId}] leave ${client.sessionId} ` +
            `(${this.clients.length} online)`
        );
    }


    onDispose() {

        console.log(`[${this.roomId}] room disposed`);
    }
}


// ==================================================
// VALIDATION
// ==================================================

function isValidId(value) {

    return typeof value === 'string' && ID_PATTERN.test(value);
}


function isValidAsset(data) {

    return (
        data &&
        isValidId(data.id) &&
        typeof data.name === 'string' &&
        data.name.length > 0 &&
        data.name.length <= 200 &&
        typeof data.dataUrl === 'string' &&
        data.dataUrl.startsWith('data:') &&
        data.dataUrl.length <= MAX_DATA_URL_LENGTH
    );
}


function isValidTransform(data) {

    return (
        !!data &&
        isVec3(data.position) &&
        isVec3(data.rotation) &&
        isVec3(data.scale)
    );
}


// Only the three known fields, nothing else stored
function pickTransform(data) {

    return {
        position: [...data.position],
        rotation: [...data.rotation],
        scale: [...data.scale]
    };
}


function isVec3(value) {

    return (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every(Number.isFinite)
    );
}
