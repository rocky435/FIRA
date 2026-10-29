// @ts-check
const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const auth = require('../middleware/auth');
const { registerLimiter, otpLimiter, otpPerEmailLimiter, loginLimiter } = require('../middleware/rateLimiters');
const fcmService = require('../services/fcmService');

/**
 * @typedef {import('../middleware/types').AuthenticatedRequest} AuthenticatedRequest
 * @typedef {import('express').Response} Response
 */

/**
 * The mobile app's device, sent with sign-in as `player_id` (the device's FCM
 * token) and `device_type` ('android' | 'ios'). Saved into the user's list of
 * app devices (fcmService) rather than onto the user, so a phone and a tablet
 * both get notifications - the same as POST /notifications/fcm/register.
 *
 * Only on login and verify-otp, never on register: a sign-up is not proven
 * until its email code is entered, and linking a device then would let someone
 * who signs up with another person's email receive that person's notifications
 * once they verify it.
 *
 * Best-effort: a missing or malformed token never fails the sign-in.
 */
async function rememberAppDevice(userId, body) {
    const token = body && (body.player_id ?? body.playerId);
    if (!userId || !token) return false;
    const type = String(body.device_type ?? body.deviceType ?? '').toLowerCase();
    try {
        await fcmService.registerToken(userId, { token, platform: type === 'ios' || type === 'android' ? type : undefined });
        return true;
    } catch (err) {
        console.warn('Could not save the app device at sign-in:', err.message);
        return false;
    }
}

// POST /api/auth/register - Register new user
router.post('/register', registerLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        // `city` is collected on the signup form and is what powers city-based
        // discovery, so it has to be forwarded to the service.
        const { email, password, name, city } = req.body;
        const result = await authService.register({ email, password, name, city });
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/register-venue-owner - Register new venue owner
router.post('/register-venue-owner', registerLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { 
            email, 
            password, 
            name, 
            businessName, 
            businessPhone,
            govIdType,
            govIdNumber,
            govIdDocument,
            bankAccountName,
            bankAccountNumber,
            bankIfscCode,
            bankName
        } = req.body;
        const result = await authService.register({ 
            email, 
            password, 
            name, 
            role: 'venue_owner',
            businessName,
            businessPhone,
            govIdType,
            govIdNumber,
            govIdDocument,
            bankDetails: {
                accountName: bankAccountName,
                accountNumber: bankAccountNumber,
                ifscCode: bankIfscCode,
                bankName: bankName
            }
        });
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/become-venue-owner - Upgrade a signed-in user to also be a
// venue owner (Option A "become a host" flow). Requires an authenticated
// account; adds the venue_owner role and stores owner onboarding details.
router.post('/become-venue-owner', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const {
            businessName,
            businessPhone,
            govIdType,
            govIdNumber,
            govIdDocument,
            bankAccountName,
            bankAccountNumber,
            bankIfscCode,
            bankName
        } = req.body;
        const result = await authService.becomeVenueOwner({
            userId: req.user._id,
            businessName,
            businessPhone,
            govIdType,
            govIdNumber,
            govIdDocument,
            bankDetails: {
                accountName: bankAccountName,
                accountNumber: bankAccountNumber,
                ifscCode: bankIfscCode,
                bankName: bankName
            }
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/verify-otp - Verify OTP and activate account
router.post('/verify-otp', otpLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email and verification code are required' });
        }

        const result = await authService.verifyOTP({ email, code });
        const deviceSaved = await rememberAppDevice(result.user && result.user._id, req.body);
        res.json({ ...result, deviceSaved });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/resend-otp - Resend OTP
router.post('/resend-otp', otpLimiter, otpPerEmailLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const result = await authService.resendOTP({ email });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/login - Login user
router.post('/login', loginLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await authService.login({ email, password });
        const deviceSaved = await rememberAppDevice(result.user && result.user._id, req.body);
        res.json({ ...result, deviceSaved });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// POST /api/auth/logout - Logout user (adds token to blocklist)
// The app sends `player_id` (its FCM token) so this phone stops getting the
// user's notifications; their other devices keep theirs. Nothing is cleared
// without it: the website logs out here too, and signing out of the browser
// must not silence the user's phone.
router.post('/logout', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const playerId = req.body && (req.body.player_id ?? req.body.playerId);
        try {
            if (playerId) await fcmService.removeToken(req.user._id, String(playerId));
        } catch (err) {
            console.warn('Could not clear app devices at logout:', err.message);
        }

        const { blockToken } = require('../services/tokenBlocklist');
        const { blocked, error } = await blockToken(req.token);

        if (!blocked) {
            return res.status(503).json({ error: error || 'Unable to invalidate session' });
        }

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// POST /api/auth/refresh - Slide the session forward.
// `auth` has already verified the current (non-expired, non-blocklisted) token
// and loaded req.user, so this just mints a fresh 7-day token. An active user
// hitting this before expiry never gets logged out; a user whose token already
// expired gets a 401 here (same as any protected route) and signs in again.
router.post('/refresh', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await authService.refreshSession({ userId: req.user._id });
        res.json(result);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// GET /api/auth/me - Get current user
router.get('/me', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        res.json({ user: req.user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/auth/forgot-password - Request password reset
router.post('/forgot-password', otpLimiter, otpPerEmailLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const result = await authService.forgotPassword({ email });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/verify-reset-otp - Verify reset code
router.post('/verify-reset-otp', otpLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code are required' });
        }

        const result = await authService.verifyResetOTP({ email, code });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/reset-password - Reset password with token
router.post('/reset-password', loginLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { resetToken, newPassword } = req.body;

        if (!resetToken || !newPassword) {
            return res.status(400).json({ error: 'Reset token and new password are required' });
        }

        const result = await authService.resetPassword({ resetToken, newPassword });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/auth/change-password - Change password while signed in.
// Requires auth: the user id comes from the token, never from the body, so a
// caller cannot change somebody else's password by passing their id.
router.post('/change-password', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        const result = await authService.changePassword({
            userId: req.user._id,
            currentPassword,
            newPassword
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
