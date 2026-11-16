const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

/**
 * Web Push delivery.
 *
 * Sending is always best-effort: a push that fails must never break the action
 * that triggered it (buying a ticket, following a creator). Every public method
 * here swallows its own errors and reports counts instead of throwing.
 */

let isConfigured = false;

function configure() {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.warn('⚠️  Web Push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set.');
        console.warn('   Generate them with: node server/scripts/generateVapidKeys.js');
        return false;
    }

    webpush.setVapidDetails(
        VAPID_SUBJECT || 'mailto:no-reply@letsfira.com',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
    console.log('✅ Web Push configured');
    return true;
}

isConfigured = configure();

const pushService = {
    isEnabled() {
        return isConfigured;
    },

    getPublicKey() {
        return process.env.VAPID_PUBLIC_KEY || null;
    },

    /**
     * Register (or refresh) a browser subscription for a user.
     * Upsert on endpoint: the same browser re-subscribing must not create a
     * duplicate, and a device that changed hands should re-point to the new user.
     */
    async saveSubscription(userId, subscription, userAgent = null, app = 'web') {
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
            throw new Error('Invalid push subscription payload');
        }

        return PushSubscription.findOneAndUpdate(
            { endpoint: subscription.endpoint },
            {
                $set: {
                    user: userId,
                    endpoint: subscription.endpoint,
                    keys: {
                        p256dh: subscription.keys.p256dh,
                        auth: subscription.keys.auth
                    },
                    userAgent,
                    app: app === 'admin' ? 'admin' : 'web',
                    lastUsedAt: new Date()
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    },

    async removeSubscription(endpoint) {
        if (!endpoint) return { removed: 0 };
        const result = await PushSubscription.deleteOne({ endpoint });
        return { removed: result.deletedCount };
    },

    /** Drop every subscription for a user - used on logout-everywhere. */
    async removeAllForUser(userId) {
        const result = await PushSubscription.deleteMany({ user: userId });
        return { removed: result.deletedCount };
    },

    /**
     * Push to every device belonging to one user.
     *
     * `payload` is what the service worker receives, so keep it small - push
     * services cap the encrypted body (~4KB) and reject anything larger.
     */
    async sendToUser(userId, payload, { app = 'web' } = {}) {
        return this.sendToUsers([userId], payload, { app });
    },

    /**
     * Push to many users at once (followers of a brand, attendees of an event).
     * `app` picks which subscriptions: the website's ('web', the default) or
     * the admin app's ('admin').
     */
    async sendToUsers(userIds, payload, { app = 'web' } = {}) {
        if (!isConfigured || !userIds?.length) return { sent: 0, failed: 0, skipped: !isConfigured, results: [] };

        const subscriptions = await PushSubscription.find({ user: { $in: userIds }, ...appFilter(app) }).lean();
        if (subscriptions.length === 0) return { sent: 0, failed: 0, results: [] };

        return this._dispatch(subscriptions, payload);
    },

    async _dispatch(subscriptions, payload) {
        const body = JSON.stringify({
            title: payload.title || 'FIRA',
            body: payload.body || '',
            url: payload.url || '/notifications',
            tag: payload.tag || undefined,
            icon: payload.icon || '/logo white.png',
            data: payload.data || {}
        });

        // Endpoints the push service told us are dead. Collected and deleted in
        // one go rather than N deletes interleaved with the sends.
        const expired = [];
        let sent = 0;
        let failed = 0;

        // What each device's push service answered, so a test can show it
        // (Apple's web.push.apple.com, Google's fcm.googleapis.com, Mozilla...).
        const results = [];

        await Promise.all(subscriptions.map(async (sub) => {
            const service = pushServiceName(sub.endpoint);
            try {
                const res = await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: sub.keys },
                    body,
                    // High urgency: Apple and Google may otherwise hold a push
                    // for a sleeping phone until it wakes. Kept for a day.
                    { urgency: 'high', TTL: 24 * 60 * 60 }
                );
                sent++;
                results.push({ service, ok: true, status: res?.statusCode ?? 201 });
            } catch (error) {
                const status = error.statusCode || null;
                const reason = pushErrorReason(error);
                // 404/410 mean the subscription is permanently gone. Anything
                // else (network, 429, 500) is transient - keep the row.
                if (status === 404 || status === 410) {
                    expired.push(sub.endpoint);
                } else {
                    failed++;
                    console.error(`Push failed (${service}, ${status || 'no status'}): ${reason}`);
                }
                results.push({ service, ok: false, status, reason, removed: status === 404 || status === 410 });
            }
        }));

        if (expired.length > 0) {
            await PushSubscription.deleteMany({ endpoint: { $in: expired } });
            console.log(`🧹 Pruned ${expired.length} expired push subscription(s)`);
        }

        return { sent, failed, expired: expired.length, results };
    }
};

/** Mongo filter for one app's subscriptions ('web' includes rows saved before `app` existed). */
function appFilter(app) {
    return app === 'admin' ? { app: 'admin' } : { app: { $ne: 'admin' } };
}

/** "Apple", "Google", "Mozilla", "Microsoft" or the host, from a subscription endpoint. */
function pushServiceName(endpoint) {
    try {
        const host = new URL(endpoint).host;
        if (host.endsWith('push.apple.com')) return 'Apple';
        if (host.includes('googleapis.com')) return 'Google';
        if (host.includes('mozilla')) return 'Mozilla';
        if (host.includes('windows.com') || host.includes('microsoft')) return 'Microsoft';
        return host;
    } catch {
        return 'unknown';
    }
}

/** The push service's own reason for a refusal, short enough to show. */
function pushErrorReason(error) {
    const body = typeof error.body === 'string' ? error.body.trim() : '';
    let reason = body;
    try {
        const parsed = JSON.parse(body);
        reason = parsed.reason || parsed.error?.message || parsed.message || body;
    } catch { /* not JSON */ }
    return String(reason || error.message || 'Unknown error').slice(0, 200);
}

module.exports = pushService;
