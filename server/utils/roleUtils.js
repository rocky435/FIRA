// @ts-check

/**
 * Compute the role array after granting `role` to an account.
 *
 * `roles[]` is the source of truth; for un-migrated accounts that still carry
 * only the legacy scalar `role`, seed from that instead. The grant is
 * idempotent - a role already held is never duplicated.
 *
 * @param {string[] | undefined | null} existingRoles - the account's roles[]
 * @param {string | undefined | null} legacyRole - the legacy scalar role
 * @param {string} role - the role to grant
 * @returns {string[]} the de-duplicated role list including `role`
 */
function withRole(existingRoles, legacyRole, role) {
    const seed = Array.isArray(existingRoles) && existingRoles.length
        ? existingRoles
        : [legacyRole].filter(Boolean);
    const set = new Set(seed);
    set.add(role);
    return [...set];
}

/**
 * Whether an account holds `role`. `roles[]` is the source of truth; the legacy
 * scalar `role` still counts so un-migrated accounts are not locked out. Mirrors
 * the check in middleware/auth.js so route-level checks agree with the gate.
 *
 * @param {{ roles?: string[] | null, role?: string | null } | null | undefined} user
 * @param {string} role
 * @returns {boolean}
 */
function hasRole(user, role) {
    if (!user) return false;
    if (Array.isArray(user.roles) && user.roles.includes(role)) return true;
    return user.role === role;
}

module.exports = { withRole, hasRole };
