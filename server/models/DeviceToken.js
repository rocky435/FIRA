const mongoose = require('mongoose');

/**
 * A native app install's Firebase Cloud Messaging (FCM) push target: either a
 * classic registration token or a Firebase Installation ID (FID, the newer
 * target returned by firebase_messaging's register()/onRegistered). `kind`
 * says which; `token` holds the value either way.
 *
 * The native counterpart of PushSubscription (browser Web Push). One user can
 * have many: phone, tablet, a reinstall. The token is issued by FCM per app
 * install and is the natural unique key, so registering the same token again
 * refreshes the row - or re-points it to whoever signed in on that device.
 *
 * Tokens die on their own (uninstall, data cleared, token rotated). FCM reports
 * that when we send, and fcmService prunes the row.
 */
const deviceTokenSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    token: {
        type: String,
        required: true,
        unique: true
    },
    kind: {
        type: String,
        enum: ['token', 'fid'],
        default: 'token'
    },
    platform: {
        type: String,
        enum: ['android', 'ios'],
        default: 'android'
    },
    // Optional app-supplied install id, so a refreshed token replaces the old one
    deviceId: {
        type: String,
        default: null
    },
    appVersion: {
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

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
