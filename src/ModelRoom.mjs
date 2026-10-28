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
 *     'object:add'        { id, name, dataUrl, transform? }
 *     'object:transform'  { id, position, rotation, scale }
 *     'object:remove'     { id }
 *     'object:hold'       { id }
 *     'object:release'    { id }
 *     'sync-request'      { have?: [id, ...] }
 *     'session:leave'     { choice?: 'close'|'keep'|'assign', newAdminId? }
 *                         (the last online admin leaving closes
 *                         the session unless they 'assign' admin
 *                         to someone first; so does that admin
 *                         closing the tab and not coming back
 *                         within RECONNECT_WINDOW)
 *
 *   client -> server (admins only)
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
 *     'session:notice'    { text }
 *     'session:closed'    { by }
 *     'object:list'       { serverId, ids: [id, ...] }
 *     'object:add'        { id, name, dataUrl, transform, ... }
 *     'object:transform'  { id, position, rotation, scale }
 *     'object:remove'     { id }
 *     'object:rejected'   { id, reason }   (room memory full)
 *     'object:denied'     { id, reason, transform? }  (no permission;
 *                         transform = the pose to snap back to)
 *     'action:denied'     { type, reason }   (admin action refused)
 *
 * Leave codes the client can show:
 *   4101 kicked, 4102 denied, 4103 session closed,
 *   4104 opened in another tab/window
 *
 * sync-request: unchanged from the single-room
 * version - full id list, then 'object:add' for every
 * object the client does not have yet, then poses.
 * serverId changes on every server start.
 *
 * The room memory limit (MAX_ROOM_MB, default 250 MB)
 * is unchanged. Everything lives in memory: the room
 * and its objects are gone when the last person leaves.
 */

import { randomUUID } from 'node:crypto';
import { Room, ServerError } from 'colyseus';

import { getAuthAdapter } from './auth/index.mjs';
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

// Client-made ids (crypto.randomUUID or similar)
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ROLES = ['admin', 'editor', 'viewer'];

export const LEAVE_CODES = {
    KICKED: 4101,
    DENIED: 4102,
    CLOSED: 4103,
    REPLACED: 4104
};

// New for every server start (see header)
const SERVER_ID = randomUUID();


export class ModelRoom extends Room {

    // Session ends (room is disposed) when everyone
    // has left.
    autoDispose = true;

    maxClients = 50;


    onCreate(options) {

        const sessionKey = String(options?.sessionKey ?? '');

        if (!SESSION_KEY_PATTERN.test(sessionKey)) {
            throw new ServerError(400, 'Invalid session key');
        }

        // Throws if the key is already in use
        registerSession(sessionKey, this);

        this.sessionKey = sessionKey;

        // userId -> { userId, name, role, status,
        //             joinedAt, online, client }
        // status: 'pending' | 'approved'
        this.users = new Map();

        // Kicked users cannot come back
        this.banned = new Set();

        // id -> { id, name, dataUrl, transform,
        //         addedBy, assignedTo, heldBy }
        // Map keeps insertion order = import order.
        this.objects = new Map();

        this.totalBytes = 0;

        this.hasCreator = false;

        this.closed = false;

        // When the last online admin went away (ms)
        this.noAdminSince = null;


        this.registerObjectMessages();
        this.registerAdminMessages();
        this.registerSessionMessages();


        this.clock.setInterval(() => this.adminWatchdog(), 5000);


        console.log(
            `[${this.roomId}] session ${sessionKey} created ` +
            `(memory limit ${Math.round(MAX_ROOM_BYTES / 1024 / 1024)} MB)`
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

        return identity;
    }


    onJoin(client) {

        const { userId, name } = client.auth;

        client.userData = { userId };


        let user = this.users.get(userId);


        // Same person in a second tab or device: the
        // newest connection wins.
        if (user?.client && user.client !== client && user.online) {

            const old = user.client;

            old.userData = { ...old.userData, noReconnect: true };

            old.leave(LEAVE_CODES.REPLACED, 'Opened in another window');
        }


        if (!user) {

            user = {
                userId,
                name,
                role: null,
                status: 'pending',
                joinedAt: Date.now(),
                online: true,
                client
            };

            // The creator of the session is its first admin
            if (!this.hasCreator) {

                this.hasCreator = true;

                user.status = 'approved';
                user.role = 'admin';
            }

            this.users.set(userId, user);

        } else {

            // Returning approved users keep their role
            user.name = name;
        }


        user.client = client;
        user.online = true;


        if (user.status === 'approved') {

            user.ticket = user.ticket || issueTicket(this, userId);

        } else {

            for (const admin of this.onlineUsers('admin')) {
                admin.client.send('join:request', { userId, name });
            }
        }


        console.log(
            `[${this.roomId}] join "${name}" (${userId}) as ` +
            `${user.status === 'approved' ? user.role : 'pending'} ` +
            `(${this.clients.length} online)`
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

        if (user && user.client === client) {

            user.online = false;

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

        if (user) {

            user.client = client;
            user.online = true;

            this.sendState();
        }

        console.log(`[${this.roomId}] reconnect ${client.sessionId}`);
    }


    // Final leave: on purpose, kicked, or the
    // reconnection window ran out.
    onLeave(client) {

        const user = this.userOf(client);

        if (!user || user.client !== client) {
            return;   // replaced by a newer connection
        }

        user.online = false;
        user.client = null;

        // Pending people who give up are forgotten
        if (user.status === 'pending') {
            this.users.delete(user.userId);
        }

        this.releaseHoldsOf(user.userId);


        console.log(
            `[${this.roomId}] leave "${user.name}" ` +
            `(${this.clients.length} online)`
        );


        // The last admin is gone for good (tab closed,
        // not back in time): the session ends with them
        if (user.role === 'admin' && user.status === 'approved' && this.onlineUsers('admin').length === 0) {

            this.closeSession(user);

            return;
        }


        this.sendState();
    }


    onDispose() {

        // onCreate refused the key
        if (!this.sessionKey) {
            return;
        }

        unregisterSession(this.sessionKey, this);

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

        this.onApproved('object:add', (client, user, data) => {

            if (!isValidAsset(data)) {

                console.warn(`[${this.roomId}] rejected object from ${user.name}`);

                return;
            }


            const previous = this.objects.get(data.id);

            const reason = this.editDenial(user, previous);

            if (reason) {

                this.deny(client, data.id, reason, previous);

                return;
            }


            const freed = previous ? previous.dataUrl.length : 0;

            if (this.totalBytes - freed + data.dataUrl.length > MAX_ROOM_BYTES) {

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
                dataUrl: data.dataUrl,
                transform: isValidTransform(data.transform)
                    ? pickTransform(data.transform)
                    : null,
                addedBy: previous ? previous.addedBy : user.userId,
                assignedTo: previous ? previous.assignedTo : null,
                heldBy: previous ? previous.heldBy : null
            };

            this.objects.set(object.id, object);

            this.totalBytes += object.dataUrl.length - freed;


            console.log(
                `[${this.roomId}] add "${object.name}" ` +
                `(${Math.round(object.dataUrl.length / 1024)} KB) ` +
                `by ${user.name} - ${this.objects.size} objects, ` +
                `${Math.round(this.totalBytes / 1024 / 1024)} MB`
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

            this.totalBytes -= object.dataUrl.length;


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


            object.heldBy = user.userId;

            this.sendState();
        });


        this.onApproved('object:release', (client, user, data) => {

            const object = isValidId(data?.id) ? this.objects.get(data.id) : null;

            if (object && object.heldBy === user.userId) {

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

        this.onAdmin('join:approve', (client, admin, data) => {

            const user = this.users.get(data?.userId);

            if (!user || user.status !== 'pending') {
                return this.actionDenied(client, 'join:approve', 'That person is not waiting');
            }

            if (!ROLES.includes(data.role)) {
                return this.actionDenied(client, 'join:approve', 'Unknown role');
            }


            user.status = 'approved';
            user.role = data.role;
            user.ticket = issueTicket(this, user.userId);


            console.log(`[${this.roomId}] ${admin.name} approved "${user.name}" as ${user.role}`);


            // The client asks for the models (sync-request)
            // when it sees its status change to approved.
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

            this.fixLocks();

            this.sendState();
        });


        this.onAdmin('object:unassign', (client, admin, data) => {

            const object = this.objects.get(data?.id);

            if (!object) {
                return this.actionDenied(client, 'object:unassign', 'Unknown object');
            }


            object.assignedTo = null;

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
    }


    // ==============================================
    // LEAVING
    // ==============================================

    registerSessionMessages() {

        /*
         * Leave button. Only matters for the last
         * online admin:
         *   assign - make newAdminId admin, then leave
         *   anything else - the session ends for everyone
         * Everyone else simply leaves.
         */
        this.onApproved('session:leave', (client, user, data) => {

            const choice = data?.choice || 'keep';

            const lastAdmin =
                user.role === 'admin' &&
                this.onlineUsers('admin').length <= 1;


            // The last admin leaving ends the session (and
            // its link), unless they hand admin over first
            if (lastAdmin && choice !== 'assign') {

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


        const byAge = (a, b) => a.joinedAt - b.joinedAt;

        const next =
            online.filter((u) => u.role === 'editor').sort(byAge)[0] ||
            online.filter((u) => u.role === 'viewer').sort(byAge)[0];

        if (!next) {
            return;
        }


        next.role = 'admin';

        this.noAdminSince = null;

        this.fixLocks();


        console.log(`[${this.roomId}] no admin online - promoted "${next.name}"`);


        this.sendApproved('session:notice', {
            text: `${next.name} is now admin (no admin was online)`
        });

        this.sendState();
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
            role: user.role
        };


        if (user.status !== 'approved') {
            return { sessionKey: this.sessionKey, you };
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
                joinedAt: u.joinedAt
            });
        }


        const objects = [];

        for (const o of this.objects.values()) {

            objects.push({
                id: o.id,
                name: o.name,
                addedBy: o.addedBy,
                assignedTo: o.assignedTo,
                heldBy: o.heldBy
            });
        }


        return {
            sessionKey: this.sessionKey,
            you,
            users,
            objects,
            adminGraceSeconds: ADMIN_GRACE_SECONDS,
            noAdminSince: this.noAdminSince
        };
    }


    sendState() {

        for (const user of this.users.values()) {

            if (user.online && user.client) {
                user.client.send('session:state', this.stateFor(user));
            }
        }
    }


    // Like broadcast, but never to pending people
    sendApproved(type, message, except) {

        for (const user of this.users.values()) {

            if (
                user.status === 'approved' &&
                user.online &&
                user.client &&
                user.client !== except
            ) {
                user.client.send(type, message);
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


    disconnectUser(user, code, reason) {

        const client = user.client;

        user.online = false;
        user.client = null;

        revokeTickets(this, user.userId);
        this.releaseHoldsOf(user.userId);

        if (client) {

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


    // Message handler for approved users only
    onApproved(type, handler) {

        this.onMessage(type, (client, data) => {

            const user = this.userOf(client);

            if (!user || user.status !== 'approved' || user.client !== client) {
                return;
            }

            handler(client, user, data);
        });
    }


    // Message handler for admins only
    onAdmin(type, handler) {

        this.onApproved(type, (client, user, data) => {

            if (user.role !== 'admin') {
                return this.actionDenied(client, type, 'Only admins can do this');
            }

            handler(client, user, data);
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
