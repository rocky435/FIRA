const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');
const pushService = require('../services/pushService');
const fcmService = require('../services/fcmService');
const sse = require('../lib/sse');

const auth = require('../middleware/auth');
const { noStoreCache } = require('../middleware/httpCache');

/* ------------------------------------------------------------------ *
 * SSE — Real-time notification stream
 *
 * GET /api/v1/notifications/stream
 * Requires authentication. Streams events as text/event-stream.
 * Sends a heartbeat comment every 30s to prevent proxy idle-timeout.
 * ------------------------------------------------------------------ */

// The connection registry lives in lib/sse.js so chat and read receipts can push
// over this same stream instead of opening a second one.
router.get('/stream', auth, (req, res) => {
    const unregister = sse.register(req.user._id, res);
    req.on('close', unregister);
});

// GET /api/notifications - Get user's notifications
router.get('/', auth, noStoreCache, async (req, res) => {
    try {
        const notifications = await notificationService.getUserNotifications(req.user._id);
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/* ------------------------------------------------------------------ *
 * Web Push
 *
 * These sit ABOVE the `/:id` routes on purpose - Express matches in
 * order, so "/push/public-key" would otherwise be swallowed by "/:id".
 * ------------------------------------------------------------------ */

// GET /api/notifications/push/public-key - VAPID public key for the browser
router.get('/push/public-key', (req, res) => {
    const publicKey = pushService.getPublicKey();
    if (!publicKey) {
        return res.status(503).json({ error: 'Push notifications are not configured on this server' });
    }
    res.json({ publicKey });
});

// POST /api/notifications/push/subscribe - register this browser
router.post('/push/subscribe', auth, async (req, res) => {
    try {
        const { subscription } = req.body;
        await pushService.saveSubscription(
            req.user._id,
            subscription,
            req.header('User-Agent') || null
        );
        res.status(201).json({ success: true, message: 'Push notifications enabled' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/notifications/push/unsubscribe - drop this browser
router.post('/push/unsubscribe', auth, async (req, res) => {
    try {
        const { endpoint } = req.body;
        const result = await pushService.removeSubscription(endpoint);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/notifications/push/test - send yourself a test push
router.post('/push/test', auth, async (req, res) => {
    try {
        const result = await pushService.sendToUser(req.user._id, {
            title: 'FIRA notifications are on 🎉',
            body: "That's what an alert will look like. You're all set.",
            url: '/notifications'
        });
        if (result.sent === 0) {
            return res.status(404).json({
                error: 'No active push subscription found for this account on any device.'
            });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/* ------------------------------------------------------------------ *
 * Native app push (FCM)
 *
 * The Flutter app registers its FCM token after sign-in and on every
 * token refresh, and unregisters it before logout. Web Push above is
 * unchanged. Also above `/:id` for the same reason.
 * ------------------------------------------------------------------ */

// POST /api/notifications/fcm/register - { fid | token, platform?, deviceId?, appVersion?, previousToken? }
router.post('/fcm/register', auth, async (req, res) => {
    try {
        const { token, fid, platform, deviceId, appVersion, previousToken } = req.body || {};
        await fcmService.registerToken(req.user._id, { token, fid, platform, deviceId, appVersion, previousToken });
        res.status(201).json({ success: true, pushEnabled: fcmService.isEnabled() });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/notifications/fcm/unregister - { fid | token } - call before logout
router.post('/fcm/unregister', auth, async (req, res) => {
    try {
        const result = await fcmService.removeToken(req.user._id, req.body?.fid ?? req.body?.token);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/notifications/fcm/test - send yourself a test push on your app devices
router.post('/fcm/test', auth, async (req, res) => {
    try {
        if (!fcmService.isEnabled()) {
            return res.status(503).json({ error: 'App push notifications are not configured on this server' });
        }
        const result = await fcmService.sendToUser(req.user._id, {
            title: 'FIRA notifications are on 🎉',
            body: "That's what an alert will look like. You're all set.",
            url: '/notifications',
            data: { type: 'test' }
        });
        if (result.sent === 0) {
            return res.status(404).json({ error: 'No registered app device received the test notification.', ...result });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/notifications/unread - Get unread count
router.get('/unread', auth, async (req, res) => {
    try {
        const count = await notificationService.getUnreadCount(req.user._id);
        res.json({ count });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/notifications/:id - Get notification by ID
router.get('/:id', auth, async (req, res) => {
    try {
        const notification = await notificationService.getNotificationById(req.params.id, req.user._id);
        res.json(notification);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// PUT /api/notifications/:id/read - Mark as read
router.put('/:id/read', auth, async (req, res) => {
    try {
        const notification = await notificationService.markAsRead(req.params.id, req.user._id);
        res.json(notification);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/notifications/read-all - Mark all as read
router.put('/read-all', auth, async (req, res) => {
    try {
        const result = await notificationService.markAllAsRead(req.user._id);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /api/notifications/:id - Delete notification
router.delete('/:id', auth, async (req, res) => {
    try {
        await notificationService.deleteNotification(req.params.id, req.user._id);
        res.json({ message: 'Notification deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
