/*
 * ModelRoom
 * --------------------------------------------------
 * One shared GLB + its transform, relayed between
 * everyone in the room.
 *
 * Messages (same protocol as network-manager.mjs):
 *   client -> server  'asset'        { name, dataUrl }
 *   client -> server  'transform'    { position, rotation, scale }
 *   client -> server  'sync-request'
 *   server -> client  'asset'        { name, dataUrl }
 *   server -> client  'transform'    { position, rotation, scale }
 *
 * The server keeps the LAST model and transform in
 * memory so a player who joins late sees the same
 * thing as everyone else. Memory is wiped when the
 * server restarts.
 */

import { Room } from 'colyseus';


// Keep in sync with MAX_FILE_SIZE in the client
// (10 MB file -> ~13.4 MB base64 data URL).
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;

// Seconds a dropped player keeps their seat
const RECONNECT_WINDOW = 20;


export class ModelRoom extends Room {

    // Keep the room (and the shared model) alive
    // when the last player leaves.
    autoDispose = false;

    maxClients = 50;


    onCreate() {

        this.lastAsset = null;
        this.lastTransform = null;


        this.onMessage('asset', (client, data) => {

            if (!isValidAsset(data)) {

                console.warn(
                    `[${this.roomId}] rejected asset from ${client.sessionId}`
                );

                return;
            }


            this.lastAsset = {
                name: data.name,
                dataUrl: data.dataUrl
            };

            // New model starts from its default pose
            this.lastTransform = null;


            console.log(
                `[${this.roomId}] asset "${data.name}" ` +
                `(${Math.round(data.dataUrl.length / 1024)} KB) ` +
                `from ${client.sessionId}`
            );


            // Sender already shows it locally
            this.broadcast(
                'asset',
                this.lastAsset,
                { except: client }
            );
        });


        this.onMessage('transform', (client, data) => {

            if (!isValidTransform(data)) {
                return;
            }


            this.lastTransform = {
                position: data.position,
                rotation: data.rotation,
                scale: data.scale
            };


            this.broadcast(
                'transform',
                this.lastTransform,
                { except: client }
            );
        });


        this.onMessage('sync-request', (client) => {

            if (this.lastAsset) {
                client.send('asset', this.lastAsset);
            }

            // Client queues this until the model
            // finishes loading.
            if (this.lastTransform) {
                client.send('transform', this.lastTransform);
            }
        });


        console.log(`[${this.roomId}] room created`);
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

function isValidAsset(data) {

    return (
        data &&
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
        data &&
        isVec3(data.position) &&
        isVec3(data.rotation) &&
        isVec3(data.scale)
    );
}


function isVec3(value) {

    return (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every(Number.isFinite)
    );
}
