/*
 * BE WATER - multiplayer server entry point
 * --------------------------------------------------
 * Runs anywhere Node 20+ runs (Render, Railway,
 * Liara, a VPS ...). The host decides the port
 * through the PORT environment variable.
 */

import { defineServer, defineRoom } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ModelRoom } from './ModelRoom.mjs';


const PORT = Number(process.env.PORT) || 2567;

// 0.0.0.0 = accept connections from outside the
// container, not only from the same machine.
const HOST = process.env.HOST || '0.0.0.0';


const server = defineServer({

    rooms: {
        // Must match "Room Name" on the PlayCanvas
        // NetworkManager entity.
        my_room: defineRoom(ModelRoom)
    },

    transport: new WebSocketTransport({
        // Colyseus default is only 4 KB per message.
        // A 2 MB GLB is ~2.8 MB as base64.
        maxPayload: 4 * 1024 * 1024,

        // Keep-alive ping so cloud proxies do not
        // close idle connections.
        pingInterval: 10000
    }),

    express: (app) => {

        // Health check for the hosting platform and
        // a quick "is it up?" test in the browser.
        app.get('/', (req, res) => {
            res.json({
                ok: true,
                service: 'be-water-multiplayer',
                time: new Date().toISOString()
            });
        });

        app.get('/health', (req, res) => {
            res.send('ok');
        });
    }
});


server.listen(PORT, HOST).then(() => {
    console.log(`Multiplayer server listening on ${HOST}:${PORT}`);
});
