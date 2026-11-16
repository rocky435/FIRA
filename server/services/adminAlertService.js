/**
 * Alerts to admins' phones and desktops when something is waiting for them:
 * a venue, event or creator to review, an ID check, a refund to pay, a removal
 * request. Delivered as Web Push to the installed admin app only
 * (PushSubscription.app = 'admin'), never to the customer website.
 *
 * Who gets what:
 *  - review alerts (venue, event, creator) go to every admin level;
 *  - money and identity alerts (refund, ID check, removal request) go to admins
 *    and super admins, as moderators cannot act on them.
 *
 * Fire-and-forget: an alert never delays or fails the action that caused it.
 * A burst of the same kind (an event cancellation raising forty refunds) is
 * sent as one summary after a short wait instead of forty pushes.
 */
const User = require('../models/User');
const pushService = require('./pushService');

const KINDS = {
    venue: { title: 'New venue to review', url: '/venues?status=pending', everyone: true, plural: (n) => `${n} new venues to review` },
    event: { title: 'Event waiting for approval', url: '/events?tab=pending', everyone: true, plural: (n) => `${n} events waiting for approval` },
    creator: { title: 'New creator application', url: '/brands?status=pending', everyone: true, plural: (n) => `${n} new creator applications` },
    idCheck: { title: 'ID check waiting', url: '/id-checks', everyone: false, plural: (n) => `${n} ID checks waiting` },
    refund: { title: 'Refund to pay', url: '/refunds', everyone: false, plural: (n) => `${n} refunds to pay` },
    removal: { title: 'Removal requested', url: '/events', everyone: false, plural: (n) => `${n} removal requests` },
};

// How long to gather a burst before sending one summary.
const BATCH_MS = Number(process.env.ADMIN_ALERT_BATCH_MS || 20000);
const pending = new Map(); // kind -> { items: [{ body, url }], timer }

async function adminIds(everyone) {
    const filter = { $or: [{ role: 'admin' }, { roles: 'admin' }], isBlocked: { $ne: true } };
    if (!everyone) filter.adminRole = { $in: ['super_admin', 'admin', null] };
    const admins = await User.find(filter).select('_id').lean();
    return admins.map((a) => a._id);
}

async function deliver(kind, items) {
    const spec = KINDS[kind];
    const ids = await adminIds(spec.everyone);
    if (!ids.length) return { sent: 0, failed: 0 };
    const single = items.length === 1;
    return pushService.sendToUsers(ids, {
        title: single ? spec.title : spec.plural(items.length),
        body: single ? items[0].body : `${items[0].body} and ${items.length - 1} more.`,
        url: single ? (items[0].url || spec.url) : spec.url,
        // One notification per kind on the device: a newer one replaces it.
        tag: `fira-admin-${kind}`,
        data: { kind },
    }, { app: 'admin' });
}

function flush(kind) {
    const batch = pending.get(kind);
    if (!batch) return Promise.resolve(null);
    pending.delete(kind);
    clearTimeout(batch.timer);
    return deliver(kind, batch.items).catch((err) => {
        console.error(`Admin alert (${kind}) failed:`, err.message);
        return null;
    });
}

const adminAlertService = {
    KINDS,

    /**
     * Queue an alert. `body` is the one-line detail ("Lotus Hall, Pune by Priya"),
     * `url` the admin page to open (defaults to the kind's list).
     *
     * @param {keyof KINDS} kind
     * @param {{ body: string, url?: string }} item
     */
    notify(kind, item) {
        if (!KINDS[kind]) return;
        try {
            const batch = pending.get(kind) || { items: [], timer: null };
            batch.items.push({ body: String(item?.body || ''), url: item?.url });
            if (!batch.timer) {
                batch.timer = setTimeout(() => { flush(kind); }, BATCH_MS);
                if (typeof batch.timer.unref === 'function') batch.timer.unref();
            }
            pending.set(kind, batch);
        } catch (err) {
            console.error('Admin alert could not be queued:', err.message);
        }
    },

    /** Send everything queued now (tests, and shutdown). */
    async flushAll() {
        const kinds = [...pending.keys()];
        return Promise.all(kinds.map(flush));
    },
};

module.exports = adminAlertService;
