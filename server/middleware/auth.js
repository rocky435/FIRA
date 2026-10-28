// @ts-check
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isRedisAvailable, getRedisClient } = require('../services/cacheService');

/**
 * @typedef {import('./types').UserRole} UserRole
 * @typedef {import('./types').AuthenticatedRequest} AuthenticatedRequest
 */

/**
 * Resolve the caller from the Authorization header.
 *
 * Shared by requireAuth and optionalAuth so both apply exactly the same checks
 * (signature, expiry, blocklist). optionalAuth used to be a hand-rolled copy in
 * routes/inquiry.js that skipped the blocklist, so a logged-out token still
 * identified its owner there.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ user: any, token: string } | { status: number, error: string }>}
 */
async function authenticate(req) {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return { status: 401, error: 'Authentication required. No token provided.' };
    }

    // Redis blocklist check — fail closed with 503 if Redis is down.
    // ponytail: if Redis hasn't been initialized at all (no REDIS_HOST configured),
    // skip the check so the server still works without Redis in dev.
    if (process.env.REDIS_HOST) {
        if (!isRedisAvailable()) {
            return { status: 503, error: 'Authentication service temporarily unavailable. Please try again shortly.' };
        }
        const redis = getRedisClient();
        try {
            const blocked = await redis.get(`blocked:${token}`);
            if (blocked) {
                return { status: 401, error: 'Session has been invalidated. Please login again.' };
            }
        } catch (redisErr) {
            // Redis threw during the lookup — fail closed.
            return { status: 503, error: 'Authentication service temporarily unavailable. Please try again shortly.' };
        }
    }

    /** @type {any} */
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        if (/** @type {any} */ (err).name === 'TokenExpiredError') {
            return { status: 401, error: 'Session expired. Please login again.' };
        }
        return { status: 401, error: 'Invalid authentication token.' };
    }

    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
        return { status: 401, error: 'User no longer exists. Please register again.' };
    }

    // A password change/reset bumps tokenVersion, retiring every older token.
    // Tokens minted before versioning carry no `tv` and count as version 0.
    if ((decoded.tv || 0) !== (user.tokenVersion || 0)) {
        return { status: 401, error: 'Session has been invalidated. Please login again.' };
    }

    // Blocking used to do nothing: isBlocked was never checked here or at login.
    // 401 rather than 403 so the apps drop the session and return to sign-in.
    if (user.isBlocked) {
        return { status: 401, error: 'This account has been suspended. Please contact support.' };
    }

    return { user, token };
}

/**
 * Unified auth middleware with role-based access control.
 *
 * Usage:
 *   requireAuth()              → any authenticated user
 *   requireAuth('admin')       → admin only
 *   requireAuth('user','admin') → user OR admin
 *
 * Validates JWT signature + expiration. Checks token against Redis blocklist.
 * Attaches full user doc to req.user.
 * Returns 401 for missing/invalid/expired/blocklisted tokens, 403 for wrong role.
 * Returns 503 if Redis is unavailable (fail closed per requirement 3.5/5.5).
 *
 * @param {...string} roles - Allowed roles (empty = any authenticated user)
 * @returns {import('express').RequestHandler}
 */
function requireAuth(...roles) {
    return async (req, res, next) => {
        try {
            const result = await authenticate(req);
            if ('error' in result) {
                return res.status(result.status).json({ error: result.error });
            }
            const { user, token } = result;

            // Role check — if roles were specified, the user must hold at least
            // one of them. A user can carry multiple roles (Flow 7): the source
            // of truth is the `roles` array, with the legacy single `role` kept
            // for backward compatibility. So a required role matches when it is
            // in `user.roles` OR equals the legacy `user.role`.
            if (roles.length > 0) {
                const held = Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role];
                const allowed = roles.some(r => held.includes(r) || r === user.role);
                if (!allowed) {
                    return res.status(403).json({ error: 'Insufficient permissions for this action.' });
                }
            }

            /** @type {any} */ (req).user = user;
            /** @type {any} */ (req).token = token;
            next();
        } catch (error) {
            res.status(401).json({ error: 'Invalid authentication token.' });
        }
    };
}

/**
 * Attach req.user when the request carries a valid session, but never reject.
 * For public routes whose response depends on who is asking (e.g. a profile
 * that shows private fields only to its owner).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
async function optionalAuth(req, res, next) {
    try {
        if (req.header('Authorization')) {
            const result = await authenticate(req);
            if (!('error' in result)) {
                /** @type {any} */ (req).user = result.user;
                /** @type {any} */ (req).token = result.token;
            }
        }
    } catch (_) {
        // Treat any failure as anonymous - this route is public anyway.
    }
    next();
}

// Backward compat: the default export is requireAuth() with no role restriction,
// so all existing `const auth = require('../middleware/auth')` usages keep working.
const auth = /** @type {any} */ (requireAuth());

// Attach the factory so callers can do:
//   const { requireAuth } = require('../middleware/auth');
/** @type {any} */ (auth).requireAuth = requireAuth;
/** @type {any} */ (auth).optionalAuth = optionalAuth;

module.exports = auth;
module.exports.requireAuth = requireAuth;
module.exports.optionalAuth = optionalAuth;
