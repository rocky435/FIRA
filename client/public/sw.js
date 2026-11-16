/* eslint-disable no-undef */
/**
 * FIRA service worker - Web Push only.
 *
 * Deliberately does NOT cache anything. Adding offline caching here would let a
 * stale build serve indefinitely, which is a much worse bug than not having
 * offline support. Keep this file about notifications.
 *
 * Served from /sw.js so its scope is the whole origin.
 */

// Take over immediately rather than waiting for every old tab to close -
// otherwise a user who just granted permission keeps the previous worker.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        // A push with a non-JSON body still deserves to be shown.
        payload = { title: 'FIRA', body: event.data ? event.data.text() : '' };
    }

    const title = payload.title || 'FIRA';
    const options = {
        body: payload.body || '',
        icon: payload.icon || '/logo white.png',
        badge: '/logo white.png',
        // `tag` collapses repeats of the same subject into one notification
        // instead of stacking five reminders for the same event.
        tag: payload.tag || undefined,
        renotify: Boolean(payload.tag),
        data: { url: payload.url || '/notifications', ...(payload.data || {}) },
        vibrate: [100, 50, 100],
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    // /notifications, not /inbox: there is no /inbox page.
    const targetUrl = new URL(event.notification.data?.url || '/notifications', self.location.origin).href;

    event.waitUntil((async () => {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // Reuse an open FIRA tab rather than piling up a new one per tap. navigate()
        // only works on a window this worker controls and rejects otherwise (common
        // on iPhone), which left the tap doing nothing - so on failure, open a window.
        const open = clientList.find((c) => c.url.startsWith(self.location.origin));
        if (open) {
            try {
                const moved = open.url === targetUrl ? open : await open.navigate(targetUrl);
                if (moved) return moved.focus();
            } catch {
                // fall through
            }
        }
        return self.clients.openWindow ? self.clients.openWindow(targetUrl) : undefined;
    })());
});
