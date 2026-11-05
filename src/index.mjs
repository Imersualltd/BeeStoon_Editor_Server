/*
 * BeeStoon Editor Server - multiplayer server entry point
 * --------------------------------------------------
 * Runs anywhere Node 22+ runs (Render, Railway,
 * Liara, a VPS ...). The host decides the port
 * through the PORT environment variable.
 */

import { defineServer, defineRoom, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ModelRoom } from './ModelRoom.mjs';
import { getAuthAdapter, productionProblems } from './auth/index.mjs';
import { registerConvertRoute } from './convert.mjs';
import { registerExportFbxRoute } from './export-fbx.mjs';
import { registerArShareRoutes } from './ar-share.mjs';
import { registerAssetRoutes } from './assets.mjs';
import { registerMySessionsRoutes } from './my-sessions.mjs';
import { registerCreditRoutes } from './credits.mjs';
import { allowedOrigins, originFor } from './cors.mjs';
import { registerInternalRoutes } from './internal.mjs';
import { accessProblems, startAccessRecheck } from './editor-access.mjs';
import { liveRooms } from './sessions.mjs';


const PORT = Number(process.env.PORT) || 2567;

// 0.0.0.0 = accept connections from outside the
// container, not only from the same machine.
const HOST = process.env.HOST || '0.0.0.0';


// Unsafe production settings stop the server at start-up
// (accessProblems also with EDITOR_DEPLOYMENT=development)
const problems = [...productionProblems(), ...accessProblems()];

if (process.env.NODE_ENV === 'production' && process.env.EDITOR_DEPLOYMENT === 'development') {
    console.warn('EDITOR_DEPLOYMENT=development: production safety checks are OFF (development service only)');
}

if (problems.length) {
    console.error(`Refusing to start:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
}


// Check the identity settings now, so a wrong
// AUTH_PROVIDER stops the server at start-up.
getAuthAdapter();


// Colyseus answers every CORS preflight (OPTIONS) for
// the whole server, also for our own HTTP routes. Let
// browsers send the headers those routes use: the test
// account (X-Identity, My sessions with AUTH_PROVIDER=
// dev) and the ngrok free-plan header.
matchMaker.controller.DEFAULT_CORS_HEADERS['Access-Control-Allow-Headers'] +=
    ', X-Identity, ngrok-skip-browser-warning';

// Joining a room: only the allowed site origins
// (CORS_ORIGINS, see cors.mjs)
if (allowedOrigins().length) {

    delete matchMaker.controller.DEFAULT_CORS_HEADERS['Access-Control-Allow-Origin'];

    matchMaker.controller.getCorsHeaders = (headers) => {
        const origin = originFor(headers.get('origin'));
        return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    };
}


const server = defineServer({

    rooms: {
        // One room per share link. The host calls
        // create('session', { sessionKey }) with a new
        // random key; people opening the link call
        // join('session', { sessionKey }) and land in
        // that same room.
        session: defineRoom(ModelRoom).filterBy(['sessionKey'])
    },

    transport: new WebSocketTransport({
        // Colyseus default is only 4 KB per message.
        // A 10 MB GLB is ~13.4 MB as base64, plus a
        // little message overhead.
        maxPayload: 16 * 1024 * 1024,

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
                service: 'beestoon-editor-server',
                time: new Date().toISOString()
            });
        });

        app.get('/health', (req, res) => {
            res.send('ok');
        });

        // POST /convert : FBX -> GLB (see convert.mjs)
        registerConvertRoute(app);

        // POST /export/fbx : GLB -> FBX (see export-fbx.mjs)
        registerExportFbxRoute(app);

        // POST /ar/snapshots, GET /ar/<id> : AR share links (see ar-share.mjs)
        registerArShareRoutes(app);

        // POST /assets, GET /assets/<scene>/<id>.glb : model files (see assets.mjs)
        registerAssetRoutes(app);

        // GET /sessions/mine, DELETE /sessions/<key> : My sessions (see my-sessions.mjs)
        registerMySessionsRoutes(app);
        registerCreditRoutes(app);

        // GET /internal/sessions/<key>/members/<userId> : for the BeeStoon backend (see internal.mjs)
        registerInternalRoutes(app);
    }
});


server.listen(PORT, HOST).then(() => {
    console.log(`Multiplayer server listening on ${HOST}:${PORT}`);
    startAccessRecheck(liveRooms);
});
