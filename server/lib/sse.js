/**
 * Server-Sent Events fan-out.
 *
 * One registry of userId -> open responses, shared by every feature that needs
 * to push to a signed-in user (notifications, chat messages, read receipts).
 * This used to live inside routes/notification.js and was reachable only as
 * `notificationRouter.sendNotification`, which meant anything else wanting to
 * push had to require a route module. Nothing ever did, so the stream was
 * registered but never written to.
 *
 * Every frame is a plain `data:` frame carrying a JSON payload with a `type`
 * field, rather than a named SSE `event:`. The browser client reads the stream
 * with fetch (EventSource cannot send an Authorization header) and switches on
 * `type`, so one connection serves all features and an unknown type is simply
 * ignored by older clients.
 *
 * Each instance keeps the sockets it holds in an in-process Map; send() goes
 * through a Redis channel so an event raised on one instance reaches a user
 * connected to another (see "Cross-instance fan-out" below).
 */

// userId (string) -> Set<Response>
const clients = new Map();

const HEARTBEAT_MS = 30_000;

/**
 * Attach an SSE response to a user's connection set and start its heartbeat.
 * Returns a teardown function the caller must invoke on request close.
 */
function register(userId, res) {
    const key = String(userId);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // disable Nginx buffering
    });

    // Tell the client the stream is live before any real payload.
    res.write(':connected\n\n');

    // Comment-only frames keep proxies from closing an idle connection.
    const heartbeat = setInterval(() => {
        try {
            res.write(':heartbeat\n\n');
        } catch {
            // Socket died between ticks; cleanup runs via the close handler.
        }
    }, HEARTBEAT_MS);

    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(res);
    ensureSubscribed();

    return function unregister() {
        clearInterval(heartbeat);
        const set = clients.get(key);
        if (!set) return;
        set.delete(res);
        if (set.size === 0) clients.delete(key);
    };
}

/*
 * Cross-instance fan-out. Under PM2 cluster mode a user's stream is held by one
 * instance, while the event that should reach them can happen on another - so
 * about half of all live updates were silently dropped. With Redis up, send()
 * publishes to a channel every instance subscribes to, and each instance writes
 * to the sockets it holds. Without Redis (dev, or Redis down) it delivers
 * in-process, exactly as before.
 */
const CHANNEL = 'fira:sse';
let subscriber = null;

/** Subscribe this instance to the channel, once, when it first holds a stream. */
function ensureSubscribed() {
    if (subscriber) return;
    const { getRedisClient } = require('../config/redis');
    const client = getRedisClient();
    if (!client) return;

    // A subscribed connection can't run other commands, so it gets its own.
    // Offline queue on: subscribe may be issued before the connection is up, and
    // ioredis re-subscribes by itself after a reconnect.
    subscriber = client.duplicate({ enableOfflineQueue: true });
    subscriber.on('error', () => { /* the main client already logs Redis outages */ });
    subscriber.on('message', (_channel, raw) => {
        try {
            const { userId, payload } = JSON.parse(raw);
            deliverLocal(userId, payload);
        } catch (err) {
            console.error('SSE relay failed:', err.message);
        }
    });
    subscriber.subscribe(CHANNEL).catch(err => console.error('SSE subscribe failed:', err.message));
}

/**
 * Push a payload to every open connection for one user, on whichever instance
 * holds it. Delivery here is a live-view optimisation, never the system of
 * record: persist first, then send. Fire-and-forget.
 */
function send(userId, payload) {
    const { isRedisAvailable, getRedisClient } = require('../config/redis');
    if (isRedisAvailable()) {
        const message = JSON.stringify({ userId: String(userId), payload });
        getRedisClient().publish(CHANNEL, message).catch(() => deliverLocal(userId, payload));
        return;
    }
    deliverLocal(userId, payload);
}

/** Write a payload to the connections for one user held by this instance. */
function deliverLocal(userId, payload) {
    const set = clients.get(String(userId));
    if (!set || set.size === 0) return false;

    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
        try {
            res.write(frame);
        } catch (err) {
            // A broken socket must not stop the remaining recipients.
            console.error('SSE write failed:', err.message);
        }
    }
    return true;
}

/** Push the same payload to several users (e.g. both sides of a conversation). */
function sendToMany(userIds, payload) {
    for (const id of userIds) send(id, payload);
}

module.exports = { register, send, sendToMany, deliverLocal };
