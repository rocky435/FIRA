/**
 * One place that decides what colour a status, role or action badge is.
 *
 * This used to be a `getStatusColor` / `getRoleColor` / `getActionColor` helper
 * copied into six pages, each with a slightly different idea of what "pending"
 * looked like. Pages pass the raw value; StatusBadge looks it up here.
 */

export const TONES = {
    neutral: 'bg-white/[0.06] text-gray-300 border-white/10',
    success: 'bg-green-500/10 text-green-400 border-green-500/25',
    warning: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
    danger: 'bg-red-500/10 text-red-400 border-red-500/25',
    info: 'bg-blue-500/10 text-blue-300 border-blue-500/25',
    accent: 'bg-violet-500/10 text-violet-300 border-violet-500/25',
};

// Value (lower-cased) -> tone. Anything not listed reads as neutral.
const TONE_BY_VALUE = {
    // listing / request states
    active: 'success',
    approved: 'success',
    verified: 'success',
    completed: 'success',
    paid: 'success',
    upcoming: 'success',
    ongoing: 'info',
    accepted: 'success',
    refunded: 'success',
    pending: 'warning',
    under_review: 'warning',
    processing: 'info',
    pending_approval: 'warning',
    rejected: 'danger',
    blocked: 'danger',
    suspended: 'danger',
    cancelled: 'danger',
    failed: 'danger',
    deleted: 'danger',
    expired: 'neutral',
    none: 'neutral',
    inactive: 'neutral',

    draft: 'neutral',
    // tickets: active = valid and unused, used = checked in at the door
    used: 'info',
    confirmed: 'success',
    unpaid: 'neutral',

    // audit-trail actions
    approve: 'success',
    reject: 'danger',
    block: 'danger',
    unblock: 'info',
    feature: 'warning',
    unfeature: 'neutral',
    sale: 'info',
    settle: 'success',
    reverse: 'warning',
    delete: 'danger',
    update: 'accent',

    // event visibility
    public: 'info',
    private: 'neutral',

    // roles
    super_admin: 'danger',
    admin: 'danger',
    moderator: 'warning',
    venue_owner: 'info',
    user: 'accent',

    // verification badges
    brand: 'accent',
    band: 'accent',
    organizer: 'accent',
};

export function toneFor(value) {
    if (value == null) return 'neutral';
    return TONE_BY_VALUE[String(value).toLowerCase()] || 'neutral';
}

/** "venue_owner" -> "Venue Owner", "under_review" -> "Under Review". */
export function humanize(value) {
    if (value == null || value === '') return '';
    return String(value)
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}
