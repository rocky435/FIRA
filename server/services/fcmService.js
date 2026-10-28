const fs = require('fs');
const DeviceToken = require('../models/DeviceToken');

/**
 * Native push (Firebase Cloud Messaging) for the FIRA Android/iOS apps.
 *
 * Runs alongside pushService (browser Web Push + VAPID), which is unchanged:
 * browsers and PWAs keep their subscriptions, native installs register FCM
 * tokens here, and every notification goes out on both.
 *
 * Like pushService, sending is best-effort: public send methods never throw,
 * they report counts. Without Firebase credentials the service is disabled and
 * every send is a no-op.
 *
 * Credentials (first one set wins):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  - the service account JSON, raw or base64
 *   FIREBASE_SERVICE_ACCOUNT_PATH  - path to the service account JSON file
 *   GOOGLE_APPLICATION_CREDENTIALS - standard Google credentials file path
 */

const MAX_TOKENS_PER_MULTICAST = 500; // FCM limit per sendEachForMulticast
const MAX_DEVICES_PER_USER = 10;
// FCM says the token will never work again - delete it.
const DEAD_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token'
]);

let messaging = null;
let initialised = false;

function loadServiceAccount() {
    const { FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_PATH } = process.env;
    if (FIREBASE_SERVICE_ACCOUNT_JSON) {
        const raw = FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        return JSON.parse(json);
    }
    if (FIREBASE_SERVICE_ACCOUNT_PATH) {
        return JSON.parse(fs.readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    }
    return null;
}

function getMessagingClient() {
    if (initialised) return messaging;
    initialised = true;
    try {
        const serviceAccount = loadServiceAccount();
        if (!serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            console.warn('⚠️  FCM disabled: FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_SERVICE_ACCOUNT_PATH not set.');
            return null;
        }
        const { initializeApp, cert, applicationDefault, getApps } = require('firebase-admin/app');
        const { getMessaging } = require('firebase-admin/messaging');
        const app = getApps().find(a => a.name === 'fira-fcm') || initializeApp({
            credential: serviceAccount ? cert(serviceAccount) : applicationDefault()
        }, 'fira-fcm');
        messaging = getMessaging(app);
        console.log('✅ FCM configured');
    } catch (error) {
        // Never log the credential itself - only that it could not be used.
        console.error('❌ FCM disabled: could not load Firebase credentials:', error.message);
        messaging = null;
    }
    return messaging;
}

/** FCM data values must all be strings. Drops null/undefined, stringifies the rest. */
function toStringData(data) {
    const out = {};
    for (const [key, value] of Object.entries(data || {})) {
        if (value === undefined || value === null) continue;
        out[key] = typeof value === 'string' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return out;
}

const fcmService = {
    isEnabled() {
        return Boolean(getMessagingClient());
    },

    /**
     * Register (or refresh) this install's token for a user.
     *
     * Upsert on token: registering again refreshes it, and a device that changed
     * hands re-points to the new user. `previousToken` (from onTokenRefresh) and
     * an older token with the same `deviceId` are dropped so a rotated token
     * leaves no duplicate behind. A user keeps at most MAX_DEVICES_PER_USER.
     */
    async registerToken(userId, { token, fid, platform, deviceId, appVersion, previousToken } = {}) {
        // An FID (firebase_messaging register()/onRegistered) or a classic token (getToken()).
        const kind = fid !== undefined ? 'fid' : 'token';
        token = kind === 'fid' ? fid : token;
        if (typeof token !== 'string' || token.trim().length < 20 || token.length > 4096) {
            throw new Error('A valid FCM token or fid is required');
        }
        token = token.trim();
        if (platform !== undefined && !['android', 'ios'].includes(platform)) {
            throw new Error("platform must be 'android' or 'ios'");
        }
        const cleanDeviceId = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim().slice(0, 200) : null;

        const saved = await DeviceToken.findOneAndUpdate(
            { token },
            {
                $set: {
                    user: userId,
                    token,
                    kind,
                    platform: platform || 'android',
                    deviceId: cleanDeviceId,
                    appVersion: typeof appVersion === 'string' ? appVersion.slice(0, 50) : null,
                    lastUsedAt: new Date()
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const stale = [];
        if (typeof previousToken === 'string' && previousToken && previousToken !== token) {
            stale.push({ user: userId, token: previousToken });
        }
        if (cleanDeviceId) {
            stale.push({ user: userId, deviceId: cleanDeviceId, token: { $ne: token } });
        }
        if (stale.length) await DeviceToken.deleteMany({ $or: stale });

        // Keep the newest few devices; an old install that never unregistered
        // should not be pushed to forever.
        const extra = await DeviceToken.find({ user: userId })
            .sort({ lastUsedAt: -1 })
            .skip(MAX_DEVICES_PER_USER)
            .select('_id')
            .lean();
        if (extra.length) await DeviceToken.deleteMany({ _id: { $in: extra.map(d => d._id) } });

        return saved;
    },

    /** Remove one token - only the signed-in user's own. Used on logout. */
    async removeToken(userId, token) {
        if (typeof token !== 'string' || !token) return { removed: 0 };
        const result = await DeviceToken.deleteOne({ user: userId, token });
        return { removed: result.deletedCount };
    },

    /** Drop every token for a user (account deletion). */
    async removeAllForUser(userId) {
        const result = await DeviceToken.deleteMany({ user: userId });
        return { removed: result.deletedCount };
    },

    async sendToUser(userId, payload) {
        return this.sendToUsers([userId], payload);
    },

    /**
     * Push to every native device of these users.
     * payload: { title, body, url, data } - `url` is the in-app path to open on
     * tap (sent as data.link), `data` extra key/values for the app.
     */
    async sendToUsers(userIds, payload = {}) {
        const client = getMessagingClient();
        if (!client) return { sent: 0, failed: 0, skipped: true };
        if (!userIds?.length) return { sent: 0, failed: 0 };

        try {
            const devices = await DeviceToken.find({ user: { $in: userIds } }).select('token kind').lean();
            if (devices.length === 0) return { sent: 0, failed: 0 };
            return await this._dispatch(client, devices, payload);
        } catch (error) {
            console.error('FCM send failed:', error.message);
            return { sent: 0, failed: 0, error: true };
        }
    },

    async _dispatch(client, devices, payload) {
        const title = payload.title || 'FIRA';
        const body = payload.body || '';
        const data = toStringData({
            ...(payload.data || {}),
            link: payload.url || '/notifications',
            title,
            body
        });

        let sent = 0;
        let failed = 0;
        const dead = [];

        for (let i = 0; i < devices.length; i += MAX_TOKENS_PER_MULTICAST) {
            const chunk = devices.slice(i, i + MAX_TOKENS_PER_MULTICAST);
            const tokens = chunk.filter(d => d.kind !== 'fid').map(d => d.token);
            const fids = chunk.filter(d => d.kind === 'fid').map(d => d.token);
            // Responses come back tokens first, then fids - same order as `batch`.
            const batch = [...tokens, ...fids];
            const response = await client.sendEachForMulticast({
                ...(tokens.length ? { tokens } : {}),
                ...(fids.length ? { fids } : {}),
                notification: { title, body },
                data,
                android: {
                    priority: 'high',
                    notification: { channelId: 'fira_default', sound: 'default' }
                },
                apns: { payload: { aps: { sound: 'default' } } }
            });
            response.responses.forEach((res, idx) => {
                if (res.success) {
                    sent++;
                } else if (DEAD_TOKEN_CODES.has(res.error?.code)) {
                    dead.push(batch[idx]);
                } else {
                    failed++;
                    console.error(`FCM delivery failed (${res.error?.code || 'unknown'}):`, res.error?.message);
                }
            });
        }

        if (dead.length > 0) {
            await DeviceToken.deleteMany({ token: { $in: dead } });
            console.log(`🧹 Pruned ${dead.length} invalid FCM token(s)`);
        }

        return { sent, failed, expired: dead.length };
    },

    /** Tests only: swap in a fake messaging client (null re-reads the environment). */
    _setMessagingForTests(client) {
        messaging = client;
        initialised = client !== null;
    }
};

module.exports = fcmService;
