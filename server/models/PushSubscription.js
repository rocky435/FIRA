const mongoose = require('mongoose');

/**
 * A browser's Web Push subscription.
 *
 * One user can have many: phone, laptop, work machine. Each is identified by
 * its `endpoint`, which the push service issues and which is unique per
 * browser install - so that is the natural unique key, not the user.
 *
 * Subscriptions expire on their own (browser reinstall, cache clear, user
 * revokes permission). The push service reports that as a 404/410, and
 * pushService prunes the row when it sees one.
 */
const pushSubscriptionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    endpoint: {
        type: String,
        required: true,
        unique: true
    },
    keys: {
        // Client public key used to encrypt the payload
        p256dh: { type: String, required: true },
        // Client auth secret
        auth: { type: String, required: true }
    },
    // Which app subscribed: the customer website ('web') or the installed admin
    // app ('admin'). Website notifications go only to 'web' subscriptions and
    // admin alerts only to 'admin' ones, so a tap always opens the right app.
    // Rows from before this field read as 'web'.
    app: {
        type: String,
        enum: ['web', 'admin'],
        default: 'web',
        index: true
    },
    // Helps a user recognise which device a subscription belongs to
    userAgent: {
        type: String,
        default: null
    },
    lastUsedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
