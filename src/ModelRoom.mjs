/*
 * ModelRoom - one editing session
 * --------------------------------------------------
 * Every share link is its own room (sessionKey). The
 * person who creates the room is its first admin.
 * Everyone else waits ("pending") until an admin lets
 * them in as admin, editor or viewer.
 *
 * Shared GLB objects, each with its own id and
 * transform, are relayed between the APPROVED users
 * only. Pending users never receive model data.
 *
 * Roles
 *   admin   edits everything, always (ignores locks),
 *           approves people, sets roles, assigns
 *           objects, kicks, closes the session
 *   editor  adds objects; edits an object assigned to
 *           them, or a free unassigned one. Editing
 *           (or selecting) an object "holds" it, so
 *           nobody else can change it meanwhile
 *   viewer  only looks (and can use AR)
 *
 * Messages
 *
 *   client -> server (approved users)
 *     'object:add'        { id, name, assetId, transform? }
 *                         (assetId from POST /assets, see assets.mjs;
 *                         older clients send { dataUrl } instead,
 *                         which is still kept in memory)
 *     'object:transform'  { id, position, rotation, scale }
 *     'object:remove'     { id }
 *     'object:hold'       { id }
 *     'object:release'    { id }
 *     'sync-request'      { have?: [id, ...] }
 *     'session:leave'     { choice?: 'close'|'keep'|'assign', newAdminId? }
 *                         (when the last online admin leaves
 *                         without 'close' or 'assign' - or closes
 *                         the tab and is not back within
 *                         RECONNECT_WINDOW, or goes idle - admin
 *                         passes to the oldest online editor;
 *                         with no editor the session closes.
 *                         There is never a session without an
 *                         admin. The creator stays the owner.)
 *     'activity'          {}  (every minute or so while the person
 *                         uses the app; IDLE_MINUTES (60) without
 *                         any message -> taken out with 4105,
 *                         warned IDLE_WARNING_MINUTES (5) before)
 *     'object:hold' by an admin on an object someone else holds
 *                         sets overrideBy: the holder keeps the
 *                         lock but cannot move it until the admin
 *                         sends 'object:release'
 *
 *   One person (same userId, i.e. the same login) may
 *   be connected from several browsers at once. They
 *   are one entry in users[] with devices = how many
 *   connections are open; every connection gets the
 *   same state and models. Leave in one browser only
 *   closes that browser (unless it closes the session).
 *
 *     'scene:save'        { name, description? }  (admins + editors)
 *     'scene:versions'    {}  -> 'scene:versions' { versions }
 *
 *   Saved sessions (scene-versions.mjs): the first save
 *   makes the session a saved session owned by its
 *   creator. Autosave every AUTOSAVE_MINUTES while
 *   something changed, and when the session ends. The
 *   same link opens it again later: only the owner can
 *   start it, then people who were in it come back with
 *   their role.
 *
 *   client -> server (admins only)
 *     'scene:restore'     { versionId }  (unsaved changes are
 *                         saved first as "Before restore"; the
 *                         result is saved as 'Restored "<name>"',
 *                         so it is what the session opens with)
 *     'invite:email'      { emails: [..], role, link }
 *                         (standard text + "Join session" button)
 *                         (only when features.emailInvites; the
 *                         invited email signs in -> approved with
 *                         that role, no waiting)
 *     'join:approve'      { userId, role }
 *     'join:deny'         { userId }
 *     'role:set'          { userId, role }
 *     'object:assign'     { id, userId }
 *     'object:unassign'   { id }
 *     'object:swap'       { idA, idB }   (swap the two assignees)
 *     'user:kick'         { userId }
 *     'session:close'     {}
 *
 *   server -> client
 *     'session:state'     see stateFor() - sent on every
 *                         change of people, roles or locks
 *     'join:request'      { userId, name }   (admins)
 *     'invite:result'     { sent: [email], failed: [{ email, reason }] }
 *     'session:notice'    { text }
 *     'session:idle-warning' { secondsLeft }
 *     'session:closed'    { by }
 *     'object:list'       { serverId, ids: [id, ...] }
 *     'object:add'        { id, name, assetId, size, url, transform, ... }
 *                         (or dataUrl for a model from an older client)
 *     'object:transform'  { id, position, rotation, scale }
 *     'object:remove'     { id }
 *     'object:rejected'   { id, reason }   (room memory full)
 *     'object:denied'     { id, reason, transform? }  (no permission;
 *                         transform = the pose to snap back to)
 *     'action:denied'     { type, reason }   (admin action refused)
 *     'scene:saved'       { version }   (version summary)
 *     'scene:restored'    { version, by }
 *                         (then object:remove / add / transform)
 *
 * Leave codes the client can show:
 *   4101 kicked, 4102 denied, 4103 session closed,
 *   4105 taken out after IDLE_MINUTES without activity,
 *   4104 opened in another tab/window (no longer sent:
 *   several browsers are allowed)
 *
 * sync-request: unchanged from the single-room
 * version - full id list, then 'object:add' for every
 * object the client does not have yet, then poses.
 * serverId changes on every server start.
 *
 * Session type (create option sessionType: single,
 * basic, workshop; see session-types.mjs) limits the
 * number of people, the size of one model file and of
 * all model files together. The memory limit
 * (MAX_ROOM_MB, default 250 MB) now only applies to
 * models from older clients sent as data URLs. The room
 * itself still lives in memory and is gone when the
 * last person leaves; model files are in storage.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { Room, ServerError } from 'colyseus';

import { getAuthAdapter } from './auth/index.mjs';
import { cleanEmail } from './auth/util.mjs';
import { mailerReady, sendInvite } from './mailer.mjs';
import { ASSET_ID_PATTERN, blobKey, SCENE_ID_PATTERN } from './assets.mjs';
import { SESSION_TYPES, sessionTypeOf } from './session-types.mjs';
import { getSceneStorage } from './scene-storage.mjs';
import {
    balanceOf, charge, creditsEnabled, ENTRY_COST, MAX_POOL,
    poolFromOptions, SESSION_COSTS
} from './credits.mjs';
import {
    cleanText,
    latestVersion,
    loadVersion,
    MAX_VERSION_DESCRIPTION,
    MAX_VERSION_NAME,
    saveVersion,
    sceneOfKey,
    updateScene
} from './scene-versions.mjs';
import {
    issueTicket,
    markClosed,
    registerSession,
    revokeTickets,
    SESSION_KEY_PATTERN,
    unregisterSession
} from './sessions.mjs';


// Keep in sync with MAX_FILE_SIZE in the client
// (10 MB file -> ~13.4 MB base64 data URL).
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;

// Total size of all models in one room. Render's free
// plan has 512 MB RAM for everything, so stay well below.
const MAX_ROOM_BYTES =
    (Number(process.env.MAX_ROOM_MB) || 250) * 1024 * 1024;

// Seconds a dropped player keeps their seat
const RECONNECT_WINDOW =
    Number(process.env.RECONNECT_WINDOW) || 20;

// Seconds without any online admin before someone
// is promoted automatically
const ADMIN_GRACE_SECONDS =
    Number(process.env.ADMIN_GRACE_SECONDS) || 60;

// Minutes between autosaves while something changed
// (0 = no timed autosave; the session end still saves)
const AUTOSAVE_MINUTES =
    Number(process.env.AUTOSAVE_MINUTES ?? 5);

// Minutes without any activity before someone is
// taken out of the session (admins too), and how long
// before that they are warned
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES) || 60;
const IDLE_WARNING_MINUTES = Math.min(
    Number(process.env.IDLE_WARNING_MINUTES) || 5,
    IDLE_MINUTES / 2
);

// Seconds between two saves by hand in one session
const SAVE_COOLDOWN_SECONDS = 3;

// Client-made ids (crypto.randomUUID or similar)
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ROLES = ['admin', 'editor', 'viewer'];

// Email invites: addresses per message, and per
// session per hour (spam brake)
const MAX_INVITES_PER_MESSAGE = 20;
const MAX_INVITES_PER_HOUR = 50;

export const LEAVE_CODES = {
    KICKED: 4101,
    DENIED: 4102,
    CLOSED: 4103,
    REPLACED: 4104,
    INACTIVE: 4105
};

// New for every server start (see header)
const SERVER_ID = randomUUID();


export class ModelRoom extends Room {

    // Session ends (room is disposed) when everyone
    // has left.
    autoDispose = true;

    maxClients = 50;


    async onCreate(options) {

        const sessionKey = String(options?.sessionKey ?? '');

        if (!SESSION_KEY_PATTERN.test(sessionKey)) {
            throw new ServerError(400, 'Invalid session key');
        }

        // A saved session behind this link? Then this
        // room re-opens it (only its owner may, onAuth).
        let saved = null;

        try {
            saved = await sceneOfKey(sessionKey);
        } catch (error) {
            console.error(`Could not read saved sessions: ${error.message}`);
        }

        // Throws if the key is already in use
        registerSession(sessionKey, this, { reopen: !!saved });

        this.sessionKey = sessionKey;

        // Saved session record (scene-versions.mjs), null
        // until the session is saved for the first time
        this.scene = saved;

        this.sessionType = saved ? sessionTypeOf(saved.sessionType) : sessionTypeOf(options?.sessionType);

        this.sessionName = saved
            ? saved.name
            : cleanText(options?.sessionName, 80) || 'Untitled session';

        // The creator owns the session for good, whoever
        // is admin later
        this.owner = saved ? saved.owner : null;

        this.limits = SESSION_TYPES[this.sessionType];

        // Credit pool (credits.mjs). A new session's pool
        // is paid by its creator on joining (onAuth).
        this.credits = saved
            ? { total: 0, left: 0, forEntry: false, forModels: false, ...saved.credits }
            : poolFromOptions(options);

        this.creatorCharged = !!saved;

        // People who paid their entry (or the pool did).
        // Earlier attendees of a saved session already did.
        this.entryPaid = new Set(Object.keys(saved?.attendees || {}));

        // Several browsers per person
        this.maxClients = Math.min(200, this.limits.people * 4);

        // Where this session's model files are stored.
        // Random and long: knowing it gives access to the
        // files (see assets.mjs).
        // (A client re-creating its room after a server
        // restart passes the sceneId it had, so its files
        // are found again.)
        this.sceneId = saved
            ? saved.sceneId
            : SCENE_ID_PATTERN.test(String(options?.sceneId ?? ''))
                ? options.sceneId
                : randomBytes(22).toString('base64url');

        // Public address of this server, for model links
        this.baseUrl = process.env.PUBLIC_BASE_URL
            ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')
            : null;

        // assetId -> { size, url }: files uploaded for this
        // session, the only ones object:add may use
        this.uploads = new Map();

        // userId -> { userId, name, email, role, status,
        //             joinedAt, online, clients, dropped }
        // status: 'pending' | 'approved'
        // clients: open connections (one per browser)
        // dropped: connections waiting to reconnect
        // online = at least one open connection
        this.users = new Map();

        // Invited email -> role (used up on first join)
        this.invites = new Map();

        // Times (ms) invites were sent, for the limit
        this.inviteTimes = [];

        // Kicked users cannot come back
        this.banned = new Set();

        // id -> { id, name, assetId, size, url, transform,
        //         addedBy, assignedTo, heldBy }
        // (dataUrl instead of assetId/size/url for a model
        // from an older client)
        // Map keeps insertion order = import order.
        this.objects = new Map();

        // Memory used by data URL models (older clients)
        this.totalBytes = 0;

        this.hasCreator = false;

        this.closed = false;

        // When the last online admin went away (ms)
        this.noAdminSince = null;

        // Saving: changes since the last save, a save
        // running, when the last save by hand was
        this.dirty = false;
        this.changeCount = 0;
        this.saving = false;
        this.lastManualSave = 0;
        this.saveError = null;


        // A saved session starts from its newest version
        if (saved) {
            await this.loadObjects(await latestVersion(saved));
        }


        this.registerObjectMessages();
        this.registerAdminMessages();
        this.registerSessionMessages();
        this.registerSceneMessages();


        this.clock.setInterval(() => this.adminWatchdog(), 5000);

        this.clock.setInterval(
            () => this.idleWatchdog(),
            Math.min(5000, IDLE_MINUTES * 60000 / 10)
        );

        if (AUTOSAVE_MINUTES > 0) {
            this.clock.setInterval(() => this.autosave(), AUTOSAVE_MINUTES * 60 * 1000);
        }


        console.log(
            `[${this.roomId}] ${this.sessionType} session ${sessionKey} ${saved ? 're-opened' : 'created'} ` +
            `(${this.limits.people} people, ${mb(this.limits.maxBytes)} MB of models)`
        );
    }


    // ==============================================
    // IDENTITY
    // ==============================================

    async onAuth(client, options, context) {

        if (this.closed) {
            throw new ServerError(410, 'This session has been closed');
        }

        let identity;

        try {
            identity = await getAuthAdapter().verify({
                token: context?.token,
                options
            });
        } catch (error) {
            throw new ServerError(401, `Login failed: ${error.message}`);
        }

        if (this.banned.has(identity.userId)) {
            throw new ServerError(403, 'You were removed from this session');
        }

        // Only the owner opens a saved session again
        if (this.scene && !this.hasCreator && identity.userId !== this.owner.userId) {
            throw new ServerError(
                403,
                `This session is closed. Only its owner (${this.owner.name}) can open it again.`
            );
        }

        // A new person (not a second browser of someone
        // already here) needs a free place
        if (!this.users.has(identity.userId) && this.users.size >= this.limits.people) {
            throw new ServerError(
                403,
                `This session is full (${this.limits.people} ${this.limits.people === 1 ? 'person' : 'people'})`
            );
        }

        await this.chargeOnJoin(identity);

        return identity;
    }


    /*
     * Credits on joining (see credits.mjs). Throws 402
     * when someone cannot pay.
     */
    async chargeOnJoin(identity) {

        if (!creditsEnabled()) {
            return;
        }

        const { userId, name, email } = identity;

        // The creator of a new session pays its type
        // and the pool
        if (!this.hasCreator && !this.creatorCharged) {

            const cost = SESSION_COSTS[this.sessionType] + this.credits.total;

            this.creatorCharged = true;

            try {
                identity.balance = await charge(
                    userId,
                    cost,
                    `Started ${this.sessionType} session "${this.sessionName}"` +
                    (this.credits.total ? ` with a pool of ${this.credits.total}` : '')
                );
            } catch (error) {
                this.creatorCharged = false;
                throw new ServerError(402, error.userMessage || 'Could not take the credits');
            }

            this.credits.left = this.credits.total;
            this.entryPaid.add(userId);

            return;
        }

        identity.balance = await balanceOf(userId);

        // Here before, a second browser, or the owner
        if (this.entryPaid.has(userId) || this.users.has(userId) || userId === this.owner?.userId) {
            return;
        }

        // Invited by email: in straight away, so pay now
        const cleanedEmail = cleanEmail(email);

        if (cleanedEmail && this.invites.has(cleanedEmail)) {

            try {
                await this.payEntry(identity);
            } catch (error) {
                throw new ServerError(402, error.userMessage || 'Could not take the credits');
            }

            return;
        }

        // Waits for an admin: pays when let in, but say
        // now if that cannot work
        if (!this.poolPaysEntry() && identity.balance < ENTRY_COST) {
            throw new ServerError(
                402,
                `You need ${ENTRY_COST} credit to join this session (you have ${identity.balance}).`
            );
        }
    }


    poolPaysEntry() {

        return this.credits.forEntry && this.credits.left >= ENTRY_COST;
    }


    // One entry, from the pool or the person
    async payEntry(person) {

        if (this.entryPaid.has(person.userId)) {
            return;
        }

        if (this.poolPaysEntry()) {

            this.credits.left -= ENTRY_COST;

            this.poolChanged();

        } else {

            const balance = await charge(person.userId, ENTRY_COST, `Joined "${this.sessionName}"`);

            person.balance = balance;
        }

        this.entryPaid.add(person.userId);
    }


    /*
     * Model generation (BeeStoon): the pool pays when the
     * admin allowed it and has enough, else the person.
     * Returns 'pool' or 'self'; throws (userMessage) when
     * neither can pay.
     */
    async spendForModel(userId, amount, reason = 'Model generation') {

        if (!creditsEnabled()) {
            return 'free';
        }

        if (this.credits.forModels && this.credits.left >= amount) {

            this.credits.left -= amount;

            this.poolChanged();

            return 'pool';
        }

        const balance = await charge(userId, amount, `${reason} in "${this.sessionName}"`);

        const user = this.users.get(userId);

        if (user) {
            user.balance = balance;
            this.sendState();
        }

        return 'self';
    }


    // Keep a saved session's pool up to date
    poolChanged() {

        if (this.scene) {
            updateScene(this.sceneId, { credits: { ...this.credits } }).catch((error) => {
                console.error(`[${this.roomId}] Could not save the credit pool: ${error.message}`);
            });
        }
    }


    onJoin(client) {

        const { userId, name, email = null, balance = null } = client.auth;

        client.userData = { userId };


        let user = this.users.get(userId);

        // Same person in another browser or device: both
        // stay connected (see header)
        const wasOnline = !!user?.online;


        if (!user) {

            user = {
                userId,
                name,
                email,
                role: null,
                status: 'pending',
                joinedAt: Date.now(),
                online: false,
                clients: new Set(),
                dropped: new Set()
            };

            // The creator of the session is its first admin
            if (!this.hasCreator) {

                this.hasCreator = true;

                this.owner = this.owner || { userId, name };

                user.status = 'approved';
                user.role = 'admin';

            } else if (this.scene?.attendees?.[userId]?.role) {

                // Was in this saved session before: back in
                // with the same role, no waiting
                user.status = 'approved';
                user.role = this.scene.attendees[userId].role;

            } else if (email && this.invites.has(email)) {

                // Invited by email: in straight away
                user.status = 'approved';
                user.role = this.invites.get(email);

                this.invites.delete(email);

                console.log(`[${this.roomId}] "${name}" joins by email invite as ${user.role}`);
            }

            this.users.set(userId, user);

        } else {

            // Returning approved users keep their role
            user.name = name;
            user.email = email || user.email;
        }


        user.clients.add(client);

        if (balance !== null && balance !== undefined) {
            user.balance = balance;
        }

        user.lastActive = Date.now();
        user.idleWarned = false;

        this.refreshOnline(user);


        if (user.status === 'approved') {

            user.ticket = user.ticket || issueTicket(this, userId);

        } else if (!wasOnline) {

            for (const admin of this.onlineUsers('admin')) {
                this.sendToUser(admin, 'join:request', { userId, name });
            }
        }


        console.log(
            `[${this.roomId}] join "${name}" (${userId}) as ` +
            `${user.status === 'approved' ? user.role : 'pending'}, ` +
            `${user.clients.size} browser(s) (${this.clients.length} connections)`
        );


        this.sendState();
    }


    // Unexpected disconnect (bad network, phone
    // locked ...) - hold the seat for a while.
    onDrop(client) {

        if (client.userData?.noReconnect) {
            return;   // onLeave runs next
        }

        const user = this.userOf(client);

        if (user?.clients.has(client)) {

            user.clients.delete(client);
            user.dropped.add(client);

            this.refreshOnline(user);

            this.sendState();
        }

        console.log(
            `[${this.roomId}] drop ${client.sessionId}, ` +
            `waiting ${RECONNECT_WINDOW}s`
        );

        this.allowReconnection(client, RECONNECT_WINDOW);
    }


    onReconnect(client) {

        const user = this.userOf(client);

        if (user?.dropped.has(client)) {

            user.dropped.delete(client);
            user.clients.add(client);

            this.refreshOnline(user);

            this.sendState();
        }

        console.log(`[${this.roomId}] reconnect ${client.sessionId}`);
    }


    // Final leave of one connection: on purpose,
    // kicked, or the reconnection window ran out.
    onLeave(client) {

        const user = this.userOf(client);

        if (!user || (!user.clients.has(client) && !user.dropped.has(client))) {
            return;   // already removed (kicked, denied ...)
        }

        user.clients.delete(client);
        user.dropped.delete(client);

        this.refreshOnline(user);


        // Still here in another browser (or one that may
        // reconnect): only that connection went away
        if (user.clients.size || user.dropped.size) {

            console.log(
                `[${this.roomId}] "${user.name}" closed one browser, ` +
                `${user.clients.size} still open`
            );

            this.sendState();

            return;
        }

        console.log(
            `[${this.roomId}] leave "${user.name}" ` +
            `(${this.clients.length} online)`
        );

        this.afterUserGone(user);
    }


    // Someone has no browser left in the session (left,
    // tab closed and not back in time, or inactive)
    afterUserGone(user) {

        // Pending people who give up are forgotten
        if (user.status === 'pending') {
            this.users.delete(user.userId);
        }

        this.releaseHoldsOf(user.userId);


        // The last admin is gone: admin goes to the
        // oldest editor; with no editor the session ends
        if (user.role === 'admin' && user.status === 'approved' && this.onlineUsers('admin').length === 0) {

            if (!this.handOverAdmin(user)) {

                this.closeSession(user);

                return;
            }
        }


        this.sendState();
    }


    /*
     * Make the oldest online editor admin (when the last
     * admin went without handing over). Ownership does
     * not move: the creator stays the owner.
     * Returns false when there is no editor online.
     */
    handOverAdmin(fromUser) {

        const next = this.onlineUsers('editor')
            .filter((u) => u.status === 'approved' && u !== fromUser)
            .sort((a, b) => a.joinedAt - b.joinedAt)[0];

        if (!next) {
            return false;
        }

        next.role = 'admin';

        this.fixLocks();

        console.log(`[${this.roomId}] admin passed to "${next.name}" (oldest editor)`);

        this.sendApproved('session:notice', {
            text: fromUser
                ? `${next.name} is now admin (${fromUser.name} left)`
                : `${next.name} is now admin (no admin was online)`
        });

        return true;
    }


    async onDispose() {

        // onCreate refused the key
        if (!this.sessionKey) {
            return;
        }

        unregisterSession(this.sessionKey, this);

        // Keep the last state of the session
        if (this.dirty) {
            await this.save({ auto: true, name: 'Session end' }, null);
        }

        console.log(`[${this.roomId}] session ${this.sessionKey} ended`);
    }


    // Used by the HTTP routes (see sessions.mjs)
    roleOf(userId) {

        const user = this.users.get(userId);

        return user && user.status === 'approved' && user.online
            ? user.role
            : null;
    }


    // ==============================================
    // OBJECT MESSAGES (approved users)
    // ==============================================

    registerObjectMessages() {

        this.onApproved('object:add', async (client, user, data) => {

            // A file of this scene from before a server
            // restart or a restore: look it up in storage
            if (isValidFileObject(data) && !this.uploads.has(data.assetId)) {
                await this.findStoredAsset(data.assetId);
            }

            const isFile = isValidFileObject(data) && this.uploads.has(data.assetId);

            if (!isFile && !isValidAsset(data)) {

                console.warn(`[${this.roomId}] rejected object from ${user.name}`);

                return;
            }


            const previous = this.objects.get(data.id);

            const reason = this.editDenial(user, previous);

            if (reason) {

                this.deny(client, data.id, reason, previous);

                return;
            }


            const freed = previous?.dataUrl ? previous.dataUrl.length : 0;

            const added = isFile ? 0 : data.dataUrl.length;

            const upload = isFile ? this.uploads.get(data.assetId) : null;


            // Session type limit, all models together
            const used = this.usedBytes(data.id) + (
                isFile
                    ? (this.usesAsset(data.assetId, data.id) ? 0 : upload.size)
                    : dataUrlBytes(data.dataUrl)
            );

            if (used > this.limits.maxBytes) {

                client.send('object:rejected', {
                    id: data.id,
                    reason: `The session is full (${mb(this.limits.maxBytes)} MB of models for a ${this.limits.label} session) - this model stays only on your screen`
                });

                return;
            }


            if (this.totalBytes - freed + added > MAX_ROOM_BYTES) {

                console.warn(`[${this.roomId}] room is full, rejected "${data.name}"`);

                client.send('object:rejected', {
                    id: data.id,
                    reason: 'The room is full (server memory limit) - this model stays only on your screen'
                });

                return;
            }


            const object = {
                id: data.id,
                name: data.name,
                ...(isFile
                    ? { assetId: data.assetId, size: upload.size, url: upload.url }
                    : { dataUrl: data.dataUrl }),
                transform: isValidTransform(data.transform)
                    ? pickTransform(data.transform)
                    : null,
                addedBy: previous ? previous.addedBy : user.userId,
                assignedTo: previous ? previous.assignedTo : null,
                heldBy: previous ? previous.heldBy : null,
                overrideBy: previous ? previous.overrideBy || null : null
            };

            this.objects.set(object.id, object);

            this.totalBytes += added - freed;

            this.markDirty();


            console.log(
                `[${this.roomId}] add "${object.name}" ` +
                `(${Math.round((isFile ? object.size : dataUrlBytes(object.dataUrl)) / 1024)} KB` +
                `${isFile ? '' : ', data URL'}) ` +
                `by ${user.name} - ${this.objects.size} objects, ` +
                `${mb(this.usedBytes())} of ${mb(this.limits.maxBytes)} MB`
            );


            // Sender already shows it locally
            this.sendApproved('object:add', object, client);

            this.sendState();
        });


        this.onApproved('object:transform', (client, user, data) => {

            if (!isValidId(data?.id) || !isValidTransform(data)) {
                return;
            }


            const object = this.objects.get(data.id);

            if (!object) {
                return;
            }


            const reason = this.editDenial(user, object);

            if (reason) {

                this.deny(client, object.id, reason, object);

                return;
            }


            // An editor who moves a free object holds it
            if (user.role === 'editor' && !object.heldBy) {

                object.heldBy = user.userId;

                this.sendState();
            }


            object.transform = pickTransform(data);

            this.markDirty();

            this.sendApproved(
                'object:transform',
                { id: object.id, ...object.transform },
                client
            );
        });


        this.onApproved('object:remove', (client, user, data) => {

            const object = isValidId(data?.id) ? this.objects.get(data.id) : null;

            if (!object) {
                return;
            }


            const reason = this.editDenial(user, object);

            if (reason) {

                this.deny(client, object.id, reason, object);

                return;
            }


            this.objects.delete(object.id);

            if (object.dataUrl) {
                this.totalBytes -= object.dataUrl.length;
            }

            this.markDirty();


            console.log(
                `[${this.roomId}] remove "${object.name}" by ${user.name} ` +
                `- ${this.objects.size} objects left`
            );


            this.sendApproved('object:remove', { id: object.id }, client);

            this.sendState();
        });


        this.onApproved('object:hold', (client, user, data) => {

            const object = isValidId(data?.id) ? this.objects.get(data.id) : null;

            if (!object || object.heldBy === user.userId) {
                return;
            }


            // Admins take the object over; everyone
            // else needs edit rights on it.
            const reason = user.role === 'admin'
                ? null
                : this.editDenial(user, object);

            if (reason) {

                this.deny(client, object.id, reason);

                return;
            }


            // An admin taking an object someone else holds
            // only borrows it: the lock stays with them,
            // their moves wait until the admin lets go
            if (user.role === 'admin' && object.heldBy && object.heldBy !== user.userId) {

                object.overrideBy = user.userId;

            } else {

                object.heldBy = user.userId;
            }

            this.sendState();
        });


        this.onApproved('object:release', (client, user, data) => {

            const object = isValidId(data?.id) ? this.objects.get(data.id) : null;

            if (!object) {
                return;
            }

            if (object.overrideBy === user.userId) {

                object.overrideBy = null;

                this.sendState();

            } else if (object.heldBy === user.userId) {

                object.heldBy = null;

                this.sendState();
            }
        });


        this.onApproved('sync-request', (client, user, data) => {

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
    }


    // ==============================================
    // ADMIN MESSAGES
    // ==============================================

    registerAdminMessages() {

        this.onAdmin('join:approve', async (client, admin, data) => {

            const user = this.users.get(data?.userId);

            if (!user || user.status !== 'pending') {
                return this.actionDenied(client, 'join:approve', 'That person is not waiting');
            }

            if (!ROLES.includes(data.role)) {
                return this.actionDenied(client, 'join:approve', 'Unknown role');
            }


            if (creditsEnabled() && !this.entryPaid.has(user.userId)) {

                try {
                    await this.payEntry(user);
                } catch (error) {
                    return this.actionDenied(
                        client,
                        'join:approve',
                        `${user.name} has no credits left to enter, and the credit pool does not cover entries`
                    );
                }

                // Left or was let in meanwhile
                if (user.status !== 'pending' || !this.users.has(user.userId)) {
                    return;
                }
            }


            user.status = 'approved';
            user.role = data.role;
            user.ticket = issueTicket(this, user.userId);


            console.log(`[${this.roomId}] ${admin.name} approved "${user.name}" as ${user.role}`);


            // The client asks for the models (sync-request)
            // when it sees its status change to approved.
            this.sendState();
        });


        // Put more of the admin's credits into the pool
        this.onAdmin('credits:add', async (client, admin, data) => {

            const amount = Math.floor(Number(data?.amount));

            if (!creditsEnabled() || !Number.isFinite(amount) || amount < 1 ||
                this.credits.total + amount > MAX_POOL) {
                return this.actionDenied(client, 'credits:add', 'Not a valid amount');
            }

            try {
                admin.balance = await charge(admin.userId, amount, `Added to the pool of "${this.sessionName}"`);
            } catch (error) {
                return this.actionDenied(client, 'credits:add', error.userMessage || 'Could not take the credits');
            }

            this.credits.total += amount;
            this.credits.left += amount;

            this.poolChanged();

            console.log(`[${this.roomId}] ${admin.name} added ${amount} credits to the pool`);

            this.sendState();
        });


        // What the pool pays for
        this.onAdmin('credits:pool', (client, admin, data) => {

            if (typeof data?.forEntry === 'boolean') {
                this.credits.forEntry = data.forEntry;
            }

            if (typeof data?.forModels === 'boolean') {
                this.credits.forModels = data.forModels;
            }

            this.poolChanged();

            this.sendState();
        });


        this.onAdmin('join:deny', (client, admin, data) => {

            const user = this.users.get(data?.userId);

            if (!user || user.status !== 'pending') {
                return this.actionDenied(client, 'join:deny', 'That person is not waiting');
            }


            console.log(`[${this.roomId}] ${admin.name} denied "${user.name}"`);


            this.users.delete(user.userId);

            this.disconnectUser(user, LEAVE_CODES.DENIED, 'An admin did not let you in');

            this.sendState();
        });


        this.onAdmin('role:set', (client, admin, data) => {

            const user = this.users.get(data?.userId);

            if (!user || user.status !== 'approved') {
                return this.actionDenied(client, 'role:set', 'Unknown person');
            }

            if (!ROLES.includes(data.role)) {
                return this.actionDenied(client, 'role:set', 'Unknown role');
            }

            // Only the owner changes their own role
            if (user.userId === this.owner?.userId && user !== admin) {
                return this.actionDenied(client, 'role:set', 'Only the owner can change their own role');
            }


            // There must always be an online admin
            if (
                user.role === 'admin' &&
                data.role !== 'admin' &&
                user.online &&
                this.onlineUsers('admin').length <= 1
            ) {
                return this.actionDenied(
                    client,
                    'role:set',
                    'Make someone else admin first - a session always needs an admin'
                );
            }


            user.role = data.role;

            this.fixLocks();


            console.log(`[${this.roomId}] ${admin.name} made "${user.name}" ${user.role}`);


            this.sendState();
        });


        this.onAdmin('object:assign', (client, admin, data) => {

            const object = this.objects.get(data?.id);
            const user = this.users.get(data?.userId);

            if (!object) {
                return this.actionDenied(client, 'object:assign', 'Unknown object');
            }

            if (!user || user.status !== 'approved' || user.role === 'viewer') {
                return this.actionDenied(client, 'object:assign', 'Objects can only be assigned to editors and admins');
            }


            object.assignedTo = user.userId;

            this.markDirty();

            this.fixLocks();

            this.sendState();
        });


        this.onAdmin('object:unassign', (client, admin, data) => {

            const object = this.objects.get(data?.id);

            if (!object) {
                return this.actionDenied(client, 'object:unassign', 'Unknown object');
            }


            object.assignedTo = null;

            this.markDirty();

            this.fixLocks();

            this.sendState();
        });


        this.onAdmin('object:swap', (client, admin, data) => {

            const a = this.objects.get(data?.idA);
            const b = this.objects.get(data?.idB);

            if (!a || !b || a === b) {
                return this.actionDenied(client, 'object:swap', 'Pick two different objects');
            }


            [a.assignedTo, b.assignedTo] = [b.assignedTo, a.assignedTo];

            this.markDirty();

            this.fixLocks();

            this.sendState();
        });


        this.onAdmin('user:kick', (client, admin, data) => {

            const user = this.users.get(data?.userId);

            if (!user) {
                return this.actionDenied(client, 'user:kick', 'Unknown person');
            }

            if (user === admin) {
                return this.actionDenied(client, 'user:kick', 'Use Leave to leave the session');
            }

            // The owner can only leave by themselves
            if (user.userId === this.owner?.userId) {
                return this.actionDenied(client, 'user:kick', 'The owner of the session cannot be removed');
            }


            console.log(`[${this.roomId}] ${admin.name} kicked "${user.name}"`);


            this.banned.add(user.userId);

            this.users.delete(user.userId);

            revokeTickets(this, user.userId);

            for (const object of this.objects.values()) {

                if (object.heldBy === user.userId) {
                    object.heldBy = null;
                }

                if (object.assignedTo === user.userId) {
                    object.assignedTo = null;
                }
            }

            this.disconnectUser(user, LEAVE_CODES.KICKED, 'An admin removed you from the session');

            this.sendState();
        });


        this.onAdmin('session:close', (client, admin) => {

            this.closeSession(admin);
        });


        this.onAdmin('invite:email', (client, admin, data) => {

            this.inviteByEmail(client, admin, data).catch((error) => {

                console.error(`[${this.roomId}] invite failed: ${error.message}`);

                this.actionDenied(client, 'invite:email', 'The invite could not be sent');
            });
        });
    }


    // ==============================================
    // EMAIL INVITES
    // ==============================================

    /*
     * Emails the session link. Whoever signs in with an
     * invited address is approved with that role. The
     * link must point at this session (its ?session=).
     */
    async inviteByEmail(client, admin, data) {

        if (!mailerReady()) {
            return this.actionDenied(client, 'invite:email', 'Email invites are not set up on this server');
        }


        const role = ROLES.includes(data?.role) ? data.role : null;

        if (!role) {
            return this.actionDenied(client, 'invite:email', 'Unknown role');
        }


        const link = this.inviteLink(data?.link);

        if (!link) {
            return this.actionDenied(client, 'invite:email', 'The invite link does not belong to this session');
        }


        const raw = Array.isArray(data?.emails) ? data.emails.slice(0, MAX_INVITES_PER_MESSAGE) : [];

        const emails = [...new Set(raw.map(cleanEmail).filter(Boolean))];

        const failed = raw
            .filter((value) => !cleanEmail(value))
            .map((value) => ({ email: String(value ?? '').slice(0, 100), reason: 'Not an email address' }));


        // Spam brake: so many per session per hour
        const hourAgo = Date.now() - 60 * 60 * 1000;

        this.inviteTimes = this.inviteTimes.filter((t) => t > hourAgo);

        const room = Math.max(0, MAX_INVITES_PER_HOUR - this.inviteTimes.length);

        for (const email of emails.slice(room)) {
            failed.push({ email, reason: 'Too many invites this hour' });
        }


        const sent = [];

        for (const email of emails.slice(0, room)) {

            this.inviteTimes.push(Date.now());

            try {

                await sendInvite({ to: email, from: admin.name, role, link });

                this.invites.set(email, role);

                sent.push(email);

            } catch (error) {

                failed.push({ email, reason: error.message || 'Could not send' });
            }
        }


        console.log(
            `[${this.roomId}] ${admin.name} invited ${sent.length} by email as ${role}` +
            (failed.length ? ` (${failed.length} failed)` : '')
        );


        // The admin may have left meanwhile
        try {
            client.send('invite:result', { sent, failed });
        } catch {
            // gone
        }
    }


    // The client's share link if it opens this session,
    // else INVITE_BASE_URL?session=<key>, else null
    inviteLink(value) {

        try {

            const url = new URL(String(value ?? ''));

            if (
                (url.protocol === 'https:' || url.protocol === 'http:') &&
                url.searchParams.get('session') === this.sessionKey
            ) {
                url.hash = '';

                return url.toString();
            }

        } catch {
            // not a URL
        }


        if (process.env.INVITE_BASE_URL) {

            try {

                const url = new URL(process.env.INVITE_BASE_URL);

                url.searchParams.set('session', this.sessionKey);

                return url.toString();

            } catch {
                // bad setting
            }
        }

        return null;
    }


    // ==============================================
    // LEAVING
    // ==============================================

    registerSessionMessages() {

        // The client sends this every minute or so while
        // the person uses mouse, keyboard, touch or VR
        // controllers (pending people too)
        this.onMessage('activity', (client) => {

            const user = this.userOf(client);

            if (user?.clients.has(client)) {
                this.noteActivity(user);
            }
        });

        /*
         * Leave button. Only matters for the last
         * online admin:
         *   close  - the session ends for everyone
         *   assign - make newAdminId admin, then leave
         *   anything else - admin goes to the oldest
         *            editor; with no editor online the
         *            session ends
         * Everyone else simply leaves.
         */
        this.onApproved('session:leave', (client, user, data) => {

            const choice = data?.choice || 'keep';


            // Still open in another browser: only this one
            // leaves (unless it closes the session)
            if (user.clients.size > 1 && choice !== 'close') {

                client.userData = { ...client.userData, noReconnect: true };

                client.leave();

                return;
            }


            const lastAdmin =
                user.role === 'admin' &&
                this.onlineUsers('admin').length <= 1;


            if (lastAdmin && choice === 'close') {

                this.closeSession(user);

                return;
            }


            if (lastAdmin && choice === 'assign') {

                const next = this.users.get(data?.newAdminId);

                if (!next || next === user || next.status !== 'approved' || !next.online) {
                    return this.actionDenied(client, 'session:leave', 'Pick someone who is online');
                }

                next.role = 'admin';

                this.fixLocks();

                console.log(`[${this.roomId}] ${user.name} handed admin to "${next.name}"`);

            } else if (lastAdmin) {

                // Leaving without choosing: oldest editor,
                // or the end of the session
                if (!this.handOverAdmin(user)) {

                    this.closeSession(user);

                    return;
                }
            }


            client.userData = { ...client.userData, noReconnect: true };

            client.leave();
        });
    }


    closeSession(byUser) {

        if (this.closed) {
            return;
        }

        this.closed = true;

        markClosed(this.sessionKey);

        console.log(`[${this.roomId}] session closed by ${byUser.name}`);


        this.lock();

        this.broadcast('session:closed', { by: byUser.name });


        for (const user of this.users.values()) {
            this.disconnectUser(user, LEAVE_CODES.CLOSED, 'The session was closed');
        }
    }


    // ==============================================
    // ADMIN WATCHDOG
    // ==============================================

    /*
     * If no admin is online for ADMIN_GRACE_SECONDS,
     * the oldest online editor becomes admin; with no
     * editor, the oldest online viewer. Pending people
     * are never promoted.
     */
    adminWatchdog() {

        const online = this.onlineUsers();

        if (online.length === 0 || online.some((u) => u.role === 'admin')) {

            this.noAdminSince = null;

            return;
        }


        if (this.noAdminSince === null) {

            this.noAdminSince = Date.now();

            return;
        }


        if (Date.now() - this.noAdminSince < ADMIN_GRACE_SECONDS * 1000) {
            return;
        }


        // No session without an admin: the oldest editor
        // takes over, and with no editor it ends
        this.noAdminSince = null;

        if (this.handOverAdmin(null)) {

            this.sendState();

            return;
        }

        console.log(`[${this.roomId}] no admin and no editor online - closing`);

        this.closeSession({ name: 'the server (no admin left)' });
    }


    /*
     * Take out people who did nothing for IDLE_MINUTES
     * (they are warned IDLE_WARNING_MINUTES before). They
     * keep their role and can come back with the link.
     */
    idleWatchdog() {

        const now = Date.now();

        for (const user of [...this.users.values()]) {

            if (!user.online) {
                continue;
            }

            const idle = now - user.lastActive;

            if (idle >= IDLE_MINUTES * 60000) {

                console.log(`[${this.roomId}] "${user.name}" inactive for ${IDLE_MINUTES} min - taken out`);

                this.disconnectUser(
                    user,
                    LEAVE_CODES.INACTIVE,
                    `You were inactive for ${IDLE_MINUTES} minutes`
                );

                this.afterUserGone(user);

                if (this.closed) {
                    return;
                }

            } else if (!user.idleWarned && idle >= (IDLE_MINUTES - IDLE_WARNING_MINUTES) * 60000) {

                user.idleWarned = true;

                this.sendToUser(user, 'session:idle-warning', {
                    secondsLeft: Math.round((IDLE_MINUTES * 60000 - idle) / 1000)
                });
            }
        }
    }


    // ==============================================
    // MODEL FILES AND LIMITS
    // ==============================================

    // Bytes of all models in the session; a file used
    // by several objects counts once. exceptId leaves
    // one object out (the one being replaced).
    usedBytes(exceptId) {

        const files = new Map();

        let total = 0;

        for (const object of this.objects.values()) {

            if (object.id === exceptId) {
                continue;
            }

            if (object.assetId) {
                files.set(object.assetId, object.size);
            } else if (object.dataUrl) {
                total += dataUrlBytes(object.dataUrl);
            }
        }

        for (const size of files.values()) {
            total += size;
        }

        return total;
    }


    usesAsset(assetId, exceptId) {

        for (const object of this.objects.values()) {

            if (object.id !== exceptId && object.assetId === assetId) {
                return true;
            }
        }

        return false;
    }


    // Used by POST /assets: null, or why the file is refused
    uploadDenial(assetId, size) {

        if (size > this.limits.fileBytes) {
            return `This model is ${mb(size)} MB; a ${this.limits.label} session allows ` +
                `${mb(this.limits.fileBytes)} MB per file`;
        }

        if (!this.usesAsset(assetId) && this.usedBytes() + size > this.limits.maxBytes) {
            return `The session is full: ${mb(this.usedBytes())} of ${mb(this.limits.maxBytes)} MB ` +
                `of models used (${this.limits.label} session)`;
        }

        return null;
    }


    registerUpload(assetId, size, url) {

        this.uploads.set(assetId, { size, url });

        // Remember this server's public address for model
        // links made later (restore, older clients' models)
        if (!this.baseUrl) {
            this.baseUrl = url.slice(0, url.indexOf('/assets/'));
        }
    }


    assetUrl(assetId) {

        return this.baseUrl ? `${this.baseUrl}/assets/${this.sceneId}/${assetId}.glb` : null;
    }


    // A file of this scene already in storage (after a
    // server restart, or used by a saved version)
    async findStoredAsset(assetId) {

        try {

            const size = await getSceneStorage().sizeOf(blobKey(this.sceneId, assetId));

            if (size !== null && !this.uploads.has(assetId)) {
                this.uploads.set(assetId, { size, url: this.assetUrl(assetId) });
            }

        } catch (error) {
            console.error(`[${this.roomId}] storage lookup failed: ${error.message}`);
        }
    }


    // ==============================================
    // SAVING AND VERSIONS
    // ==============================================

    registerSceneMessages() {

        // Save a named version: admins and editors
        this.onApproved('scene:save', async (client, user, data) => {

            if (user.role !== 'admin' && user.role !== 'editor') {
                return this.actionDenied(client, 'scene:save', 'Only admins and editors can save');
            }

            const name = cleanText(data?.name, MAX_VERSION_NAME);

            if (!name) {
                return this.actionDenied(client, 'scene:save', 'Give the version a name');
            }

            if (Date.now() - this.lastManualSave < SAVE_COOLDOWN_SECONDS * 1000) {
                return this.actionDenied(client, 'scene:save', 'Saved a moment ago - try again in a few seconds');
            }

            this.lastManualSave = Date.now();

            const version = await this.save({
                name,
                description: cleanText(data?.description, MAX_VERSION_DESCRIPTION),
                auto: false
            }, user);

            if (!version) {
                this.actionDenied(client, 'scene:save', this.saveError || 'Saving failed, please try again');
            }
        });


        // Version list: everyone who is in
        this.onApproved('scene:versions', (client) => {

            client.send('scene:versions', {
                versions: [...(this.scene?.versions || [])].reverse()
            });
        });


        // Restore a version: admins only
        this.onAdmin('scene:restore', async (client, admin, data) => {

            const reason = await this.restore(admin, data?.versionId);

            if (reason) {
                this.actionDenied(client, 'scene:restore', reason);
            }
        });
    }


    markDirty() {

        this.changeCount++;

        // Clients show "unsaved changes" from the state
        if (!this.dirty) {
            this.dirty = true;
            this.sendState();
        }
    }


    autosave() {

        if (this.dirty && !this.saving && !this.closed) {
            this.save({ auto: true, name: 'Autosave' }, null);
        }
    }


    /*
     * Save the objects as a new version. byUser is null
     * for autosaves. Returns the version summary, or null
     * (reason in this.saveError).
     */
    async save(version, byUser) {

        // Nothing to keep in a session that never had a model
        if (!this.scene && this.objects.size === 0) {
            this.dirty = false;
            return null;
        }

        const changesAtStart = this.changeCount;

        this.saving = true;
        this.sendState();

        try {

            const attendees = {};

            for (const u of this.users.values()) {

                if (u.status === 'approved') {
                    attendees[u.userId] = { name: u.name, role: u.role, lastSeen: new Date().toISOString() };
                }
            }

            const { scene, version: summary } = await saveVersion(
                {
                    sceneId: this.sceneId,
                    sessionKey: this.sessionKey,
                    name: this.sessionName,
                    sessionType: this.sessionType,
                    owner: this.owner,
                    credits: { ...this.credits },
                    attendees,
                    removed: [...this.banned],
                    baseUrl: this.baseUrl
                },
                [...this.objects.values()],
                {
                    ...version,
                    savedBy: byUser
                        ? { userId: byUser.userId, name: byUser.name }
                        : { userId: null, name: 'Autosave' }
                }
            );

            this.scene = scene;

            this.saveError = null;

            if (this.changeCount === changesAtStart) {
                this.dirty = false;
            }

            console.log(
                `[${this.roomId}] saved "${summary.name}" (${summary.objectCount} models, ` +
                `${mb(summary.bytes)} MB) by ${summary.savedBy.name}`
            );

            if (!this.closed) {
                this.sendApproved('scene:saved', { version: summary });
            }

            return summary;

        } catch (error) {

            this.saveError = error.userMessage || 'Saving failed, please try again';

            console.error(`[${this.roomId}] save failed: ${error.message}`);

            if (!this.closed) {
                for (const admin of this.onlineUsers('admin')) {
                    this.sendToUser(admin, 'session:notice', { text: this.saveError });
                }
            }

            return null;

        } finally {

            this.saving = false;

            if (!this.closed) {
                this.sendState();
            }
        }
    }


    // Objects of a saved version -> this.objects (on
    // re-open). Returns the new map; nothing is sent.
    async loadObjects(manifest) {

        const objects = new Map();

        for (const o of manifest?.objects || []) {

            if (!isValidId(o.id) || !ASSET_ID_PATTERN.test(String(o.assetId))) {
                continue;
            }

            const url = o.url || this.assetUrl(o.assetId);

            this.uploads.set(o.assetId, { size: o.size, url });

            objects.set(o.id, {
                id: o.id,
                name: o.name,
                assetId: o.assetId,
                size: o.size,
                url,
                transform: isValidTransform(o.transform) ? pickTransform(o.transform) : null,
                addedBy: o.addedBy ?? null,
                // Kept: people come back with the same id
                // (an admin can unassign)
                assignedTo: o.assignedTo ?? null,
                heldBy: null
            });
        }

        this.objects = objects;
        this.totalBytes = 0;

        return objects;
    }


    /*
     * Put a saved version back for everyone. The current
     * state is saved first ("Before restore"), so a
     * restore can itself be undone. Returns null, or why
     * it was refused.
     */
    async restore(admin, versionId) {

        if (!this.scene) {
            return 'This session has no saved versions yet';
        }

        if (!this.scene.versions.some((v) => v.id === versionId)) {
            return 'Unknown version';
        }

        const manifest = await loadVersion(this.sceneId, versionId);

        if (!manifest) {
            return 'That version could not be read';
        }


        if (this.dirty) {
            await this.save({
                auto: true,
                name: 'Before restore',
                description: `Saved automatically before ${admin.name} restored "${manifest.name}"`
            }, admin);
        }


        const before = this.objects;

        const after = await this.loadObjects(manifest);


        // Tell everyone with the normal object messages
        for (const old of before.values()) {

            const next = after.get(old.id);

            if (!next || next.assetId !== old.assetId) {
                this.sendApproved('object:remove', { id: old.id });
            }
        }

        for (const next of after.values()) {

            const old = before.get(next.id);

            if (old && old.assetId === next.assetId) {

                if (next.transform) {
                    this.sendApproved('object:transform', { id: next.id, ...next.transform });
                }

            } else {
                this.sendApproved('object:add', next);
            }
        }


        console.log(`[${this.roomId}] ${admin.name} restored "${manifest.name}"`);


        // The restored scene is now the latest version, so
        // re-opening the session later starts from it (not
        // from the version saved before the restore)
        this.dirty = true;

        await this.save({
            auto: true,
            name: `Restored "${manifest.name}"`.slice(0, 80),
            description: `${admin.name} restored the version "${manifest.name}"`
        }, admin);

        this.sendApproved('scene:restored', {
            version: this.scene.versions.find((v) => v.id === versionId),
            by: admin.name
        });

        for (const user of this.onlineUsers()) {
            if (user.status === 'approved') {
                this.sendToUser(user, 'session:notice', {
                    text: `${admin.name} restored the version "${manifest.name}"`
                });
            }
        }

        this.sendState();

        return null;
    }


    // ==============================================
    // PERMISSIONS
    // ==============================================

    /*
     * null when the user may change the object (or add
     * a new one when object is undefined), otherwise
     * a short reason for the client.
     */
    editDenial(user, object) {

        if (user.role === 'admin') {
            return null;
        }

        if (user.role !== 'editor') {
            return 'Viewers cannot edit';
        }

        if (!object) {
            return null;
        }

        if (object.overrideBy) {
            return `${this.nameOf(object.overrideBy)} (admin) is moving this object`;
        }

        if (object.heldBy && object.heldBy !== user.userId) {
            return `${this.nameOf(object.heldBy)} is editing this object`;
        }

        if (object.assignedTo && object.assignedTo !== user.userId) {
            return `This object is assigned to ${this.nameOf(object.assignedTo)}`;
        }

        return null;
    }


    // After role / assignment changes: drop holds
    // their owner is no longer allowed to keep.
    fixLocks() {

        for (const object of this.objects.values()) {

            if (object.overrideBy && this.users.get(object.overrideBy)?.role !== 'admin') {
                object.overrideBy = null;
            }

            if (!object.heldBy) {
                continue;
            }

            const holder = this.users.get(object.heldBy);

            if (!holder || holder.role === 'viewer') {
                object.heldBy = null;
                continue;
            }

            if (
                holder.role === 'editor' &&
                object.assignedTo &&
                object.assignedTo !== holder.userId
            ) {
                object.heldBy = null;
            }
        }
    }


    releaseHoldsOf(userId) {

        for (const object of this.objects.values()) {

            if (object.heldBy === userId) {
                object.heldBy = null;
            }

            if (object.overrideBy === userId) {
                object.overrideBy = null;
            }
        }
    }


    // ==============================================
    // SENDING
    // ==============================================

    // Snapshot of the session, personal to `user`
    stateFor(user) {

        const you = {
            userId: user.userId,
            name: user.name,
            status: user.status,
            role: user.role,
            devices: user.clients.size
        };


        if (user.status !== 'approved') {
            return { sessionKey: this.sessionKey, sessionName: this.sessionName, you };
        }


        you.ticket = user.ticket;

        const isAdmin = user.role === 'admin';


        const users = [];

        for (const u of this.users.values()) {

            // Only admins see who is waiting
            if (u.status === 'pending' && !isAdmin) {
                continue;
            }

            users.push({
                userId: u.userId,
                name: u.name,
                role: u.role,
                status: u.status,
                online: u.online,
                joinedAt: u.joinedAt,
                // Browsers this person has open
                devices: u.clients.size
            });
        }


        const objects = [];

        for (const o of this.objects.values()) {

            objects.push({
                id: o.id,
                name: o.name,
                addedBy: o.addedBy,
                assignedTo: o.assignedTo,
                heldBy: o.heldBy,
                // An admin moving it while heldBy keeps the lock
                overrideBy: o.overrideBy || null
            });
        }


        return {
            sessionKey: this.sessionKey,
            you,
            users,
            objects,
            adminGraceSeconds: ADMIN_GRACE_SECONDS,
            noAdminSince: this.noAdminSince,
            // Open connections in total (what hosting
            // costs are counted by), for admins
            connections: isAdmin ? this.clients.length : undefined,
            sessionType: this.sessionType,
            sessionName: this.sessionName,
            // The creator, for good (admin can move to
            // others, ownership never does)
            owner: this.owner,
            scene: this.sceneStateFor(isAdmin),
            limits: {
                people: this.limits.people,
                maxBytes: this.limits.maxBytes,
                fileBytes: this.limits.fileBytes
            },
            usedBytes: this.usedBytes(),
            credits: creditsEnabled()
                ? {
                    pool: {
                        total: this.credits.total,
                        left: this.credits.left,
                        forEntry: this.credits.forEntry,
                        forModels: this.credits.forModels
                    },
                    // This person's own credits
                    balance: user.balance ?? null,
                    entryCost: ENTRY_COST,
                    sessionCost: SESSION_COSTS[this.sessionType]
                }
                : null,
            features: {
                emailInvites: isAdmin && mailerReady(),
                // POST /assets + object:add { assetId }
                assetUploads: true,
                // scene:save / scene:versions / scene:restore
                versions: true,
                // credits:add / credits:pool (admins)
                credits: creditsEnabled()
            }
        };
    }


    sceneStateFor(isAdmin) {

        const versions = this.scene?.versions || [];

        const latest = versions[versions.length - 1] || null;

        return {
            saved: !!this.scene,
            // Admins only (it names the storage folder)
            sceneId: isAdmin ? this.sceneId : undefined,
            dirty: this.dirty,
            saving: this.saving,
            versionCount: versions.length,
            latest,
            error: this.saveError
        };
    }


    sendState() {

        for (const user of this.users.values()) {

            if (user.online) {
                this.sendToUser(user, 'session:state', this.stateFor(user));
            }
        }
    }


    // To every open browser of one person
    sendToUser(user, type, message, except) {

        for (const client of user.clients) {

            if (client !== except) {
                client.send(type, message);
            }
        }
    }


    // Like broadcast, but never to pending people
    // (except = the sending connection; the sender's
    // other browsers do get it)
    sendApproved(type, message, except) {

        for (const user of this.users.values()) {

            if (user.status === 'approved' && user.online) {
                this.sendToUser(user, type, message, except);
            }
        }
    }


    deny(client, id, reason, object) {

        const message = { id, reason };

        if (object?.transform) {
            message.transform = object.transform;
        }

        client.send('object:denied', message);
    }


    actionDenied(client, type, reason) {

        client.send('action:denied', { type, reason });
    }


    // Every browser of this person
    disconnectUser(user, code, reason) {

        const clients = [...user.clients, ...user.dropped];

        user.clients.clear();
        user.dropped.clear();

        this.refreshOnline(user);

        revokeTickets(this, user.userId);
        this.releaseHoldsOf(user.userId);

        for (const client of clients) {

            client.userData = { ...client.userData, noReconnect: true };

            client.leave(code, reason);
        }
    }


    // ==============================================
    // HELPERS
    // ==============================================

    userOf(client) {

        const userId = client?.userData?.userId ?? client?.auth?.userId;

        return userId ? this.users.get(userId) : null;
    }


    refreshOnline(user) {

        user.online = user.clients.size > 0;
    }


    nameOf(userId) {

        return this.users.get(userId)?.name || 'someone';
    }


    onlineUsers(role) {

        const list = [];

        for (const user of this.users.values()) {

            if (
                user.status === 'approved' &&
                user.online &&
                (!role || user.role === role)
            ) {
                list.push(user);
            }
        }

        return list;
    }


    noteActivity(user) {

        user.lastActive = Date.now();
        user.idleWarned = false;
    }


    // Message handler for approved users only
    onApproved(type, handler) {

        this.onMessage(type, (client, data) => {

            const user = this.userOf(client);

            if (!user || user.status !== 'approved' || !user.clients.has(client)) {
                return;
            }

            this.noteActivity(user);

            Promise.resolve(handler(client, user, data)).catch((error) => {
                console.error(`[${this.roomId}] ${type} failed:`, error);
            });
        });
    }


    // Message handler for admins only
    onAdmin(type, handler) {

        this.onApproved(type, (client, user, data) => {

            if (user.role !== 'admin') {
                return this.actionDenied(client, type, 'Only admins can do this');
            }

            return handler(client, user, data);
        });
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


function isValidFileObject(data) {

    return (
        data &&
        isValidId(data.id) &&
        typeof data.name === 'string' &&
        data.name.length > 0 &&
        data.name.length <= 200 &&
        typeof data.assetId === 'string' &&
        ASSET_ID_PATTERN.test(data.assetId)
    );
}


// A base64 data URL holds about 3 bytes per 4 characters
function dataUrlBytes(dataUrl) {

    const comma = dataUrl.indexOf(',');

    return Math.floor((dataUrl.length - comma - 1) * 3 / 4);
}


function mb(bytes) {

    return Math.round(bytes / 1024 / 1024);
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
