const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const auth = require('../middleware/auth');
const { requireAuth, optionalAuth } = auth;
const { noStoreCache } = require('../middleware/httpCache');
const { hasRole } = require('../utils/roleUtils');

// GET /api/users - Get all users (admin only)
// This was open to any signed-in user and returned every account's bank and ID
// details. The admin panel lists users through /api/admin/users.
router.get('/', requireAuth('admin'), noStoreCache, async (req, res) => {
    try {
        const users = await userService.getAllUsers(req.query);
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/users/brands - Get verified brands
router.get('/brands', async (req, res) => {
    try {
        // Pass query params: type, search, sort, lat, lng, page, limit
        const result = await userService.getBrands(req.query);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Guard for changes to where payouts go.
 *
 * Once an account has payout details, changing them (add, switch default,
 * delete, edit) needs the account password - a stolen session or an unlocked
 * laptop could otherwise redirect earnings silently. Setting up the very first
 * account needs none: there is nothing to redirect yet. Either way the holder
 * gets an email after a successful change.
 *
 * 403 (not 401) for a wrong password, so the apps don't treat it as a dead session.
 */
function confirmPayoutChange(describe) {
    return async (req, res, next) => {
        try {
            const User = require('../models/User');
            const bcrypt = require('bcryptjs');
            const account = await User.findById(req.user._id).select('password email name bankAccounts bankDetails');
            const hasExisting = (account.bankAccounts || []).length > 0 || !!account.bankDetails?.accountNumber;
            if (hasExisting) {
                const { currentPassword } = req.body || {};
                if (!currentPassword || !(await bcrypt.compare(String(currentPassword), account.password))) {
                    return res.status(403).json({
                        error: 'Enter your account password to change payout details.',
                        field: 'currentPassword',
                        code: 'PASSWORD_REQUIRED'
                    });
                }
            }
            res.on('finish', () => {
                if (res.statusCode < 400) {
                    require('../services/emailService')
                        .sendPayoutAccountChangedEmail(account.email, account.name, describe(req))
                        .catch(() => {});
                }
            });
            next();
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };
}

// PATCH /api/users/me/bank-details - Update bank details
router.patch('/me/bank-details', auth, confirmPayoutChange(() => 'bank details updated'), async (req, res) => {
    try {
        const { accountName, accountNumber, ifscCode, bankName } = req.body;
        const result = await userService.updateBankDetails(req.user._id, { accountName, accountNumber, ifscCode, bankName });
        if (result.error) {
            return res.status(400).json(result);
        }
        res.json(result.bankDetails);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/* ------------------------------------------------------------------ *
 * Identity checks (services/identityService.js): the venue owner's
 * government ID and the organiser's PAN. Submitting puts it in the admin's
 * review queue; the status is the admin's to set, never the user's.
 * ------------------------------------------------------------------ */

const identityService = require('../services/identityService');

function sendIdentityError(res, error) {
    const body = { error: error.message };
    if (error.field) body.field = error.field;
    res.status(error.status || 500).json(body);
}

// GET /api/users/me/identity - status of my checks (and why one was rejected)
router.get('/me/identity', auth, noStoreCache, async (req, res) => {
    try {
        res.json(await identityService.getOwn(req.user._id));
    } catch (error) {
        sendIdentityError(res, error);
    }
});

// PUT /api/users/me/identity/gov-id - { govIdType, govIdNumber, govIdDocument }
router.put('/me/identity/gov-id', auth, async (req, res) => {
    try {
        const { govIdType, govIdNumber, govIdDocument } = req.body || {};
        res.json(await identityService.submitGovId(req.user._id, { govIdType, govIdNumber, govIdDocument }));
    } catch (error) {
        sendIdentityError(res, error);
    }
});

// PUT /api/users/me/identity/pan - { panNumber, panDocument }
router.put('/me/identity/pan', auth, async (req, res) => {
    try {
        const { panNumber, panDocument } = req.body || {};
        res.json(await identityService.submitPan(req.user._id, { panNumber, panDocument }));
    } catch (error) {
        sendIdentityError(res, error);
    }
});

/* ------------------------------------------------------------------ *
 * Payout accounts. All declared before '/:id' so the literal segments are not
 * captured as an id param.
 * ------------------------------------------------------------------ */

// GET /api/users/me/bank-accounts - list saved payout accounts
router.get('/me/bank-accounts', auth, async (req, res) => {
    try {
        const accounts = await userService.listBankAccounts(req.user._id);
        res.json({ accounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/users/me/bank-accounts - add one
router.post('/me/bank-accounts', auth, confirmPayoutChange(r => `account ending ${String(r.body.accountNumber || '').slice(-4)} added`), async (req, res) => {
    try {
        const { accountName, accountNumber, ifscCode, bankName, makeDefault } = req.body;
        const result = await userService.addBankAccount(req.user._id, {
            accountName, accountNumber, ifscCode, bankName, makeDefault,
        });
        // Field-level error so the client can mark the offending input rather than
        // showing a detached toast.
        if (result.error) return res.status(400).json(result);
        res.status(201).json({ accounts: result.accounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PATCH /api/users/me/bank-accounts/:accountId/default - promote to default
router.patch('/me/bank-accounts/:accountId/default', auth, confirmPayoutChange(() => 'default payout account switched'), async (req, res) => {
    try {
        const result = await userService.setDefaultBankAccount(req.user._id, req.params.accountId);
        if (result.error) return res.status(404).json(result);
        res.json({ accounts: result.accounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/users/me/bank-accounts/:accountId
router.delete('/me/bank-accounts/:accountId', auth, confirmPayoutChange(() => 'a payout account removed'), async (req, res) => {
    try {
        const result = await userService.deleteBankAccount(req.user._id, req.params.accountId);
        if (result.error) return res.status(404).json(result);
        res.json({ accounts: result.accounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/users/me/deletion-check - what must be finished before the account
// can be deleted (empty lists = it can be deleted now).
router.get('/me/deletion-check', auth, noStoreCache, async (req, res) => {
    try {
        const removal = require('../services/listingRemovalService');
        const blockers = await removal.accountDeletionBlockers(req.user._id);
        res.json({ canDelete: !removal.hasAny(blockers), blockers });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/users/me - Delete the authenticated user's own account + associated data
// Declared before '/:id' so "me" is not captured as an id param.
router.delete('/me', auth, async (req, res) => {
    try {
        const result = await userService.deleteAccount(req.user._id);
        res.json(result);
    } catch (error) {
        // 409 carries the list of what is still upcoming, for the app to show.
        res.status(error.status || 500).json({ error: error.message, ...(error.blockers ? { blockers: error.blockers } : {}) });
    }
});

// GET /api/users/:id - Get user by ID
// Public, but the full document (email, phone, bank and ID details) goes only to
// the account owner or an admin; everyone else gets the public profile.
router.get('/:id', optionalAuth, noStoreCache, async (req, res) => {
    try {
        const isSelfOrAdmin = !!req.user &&
            (req.user._id.toString() === req.params.id || hasRole(req.user, 'admin'));
        const user = await userService.getUserById(req.params.id, { publicOnly: !isSelfOrAdmin });
        res.json(user);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// PUT /api/users/:id - Update user
router.put('/:id', auth, async (req, res) => {
    try {
        if (req.user._id.toString() !== req.params.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const user = await userService.updateUser(req.params.id, req.body);
        res.json(user);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /api/users/:id - Delete user
router.delete('/:id', auth, async (req, res) => {
    try {
        if (req.user._id.toString() !== req.params.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        await userService.deleteUser(req.params.id);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/users/:id/follow - Follow a user
router.post('/:id/follow', auth, async (req, res) => {
    try {
        const result = await userService.followUser(req.user._id, req.params.id);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/users/:id/unfollow - Unfollow a user
router.post('/:id/unfollow', auth, async (req, res) => {
    try {
        const result = await userService.unfollowUser(req.user._id, req.params.id);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// GET /api/users/:id/following-brands - Get brands the user is following
router.get('/:id/following-brands', auth, noStoreCache, async (req, res) => {
    try {
        if (req.user._id.toString() !== req.params.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const brands = await userService.getFollowingBrands(req.params.id);
        res.json(brands);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
