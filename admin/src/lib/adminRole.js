// The signed-in admin's level (super_admin / admin / moderator), read the same
// way by every surface that hides a control by role.
//
// The login token does not carry the level, so reading it from the token always
// gave null - and every moderator saw the full menu. The level now comes from
// GET /admin/me (refreshAdminRole, called when the app opens) and is kept with
// the rest of the stored session. The token is still checked as a fallback for
// any token that does carry it. The server enforces every permission regardless;
// this only decides what to show.

const AUTH_KEY = 'fira_admin_auth';
const TOKEN_KEY = 'fira_admin_token';
export const ROLE_EVENT = 'fira-admin-role';

function storedSession() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    } catch {
        return null;
    }
}

export function getAdminRoleFromToken() {
    const session = storedSession();
    if (session && session.adminRole) return session.adminRole;
    try {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) return null;
        const payload = token.split('.')[1];
        if (!payload) return null;
        const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
        return decoded.adminRole || null;
    } catch {
        return null;
    }
}

/**
 * Store the level the server reports, and tell open screens if it changed so
 * the menu updates without a reload.
 *
 * @param {string | null} adminRole
 */
export function storeAdminRole(adminRole) {
    try {
        const session = storedSession() || {};
        if ((session.adminRole || null) === (adminRole || null)) return;
        localStorage.setItem(AUTH_KEY, JSON.stringify({ ...session, adminRole: adminRole || null }));
        window.dispatchEvent(new CustomEvent(ROLE_EVENT, { detail: adminRole || null }));
    } catch {
        // Storage blocked: the menu falls back to the full one; the server still decides.
    }
}
