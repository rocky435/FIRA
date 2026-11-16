/*
 * FIRA Admin service worker. It does one thing: when the admin is opened with
 * no connection, show offline.html instead of the browser's error page. That
 * (plus the manifest) is what lets phones and desktops install the admin as
 * an app.
 *
 * It deliberately caches NOTHING else - not index.html, not the scripts, not
 * API answers. The admin shows live money and approval data, and a deploy must
 * reach everyone at once; a cached copy of either would be wrong.
 */
const CACHE = 'fira-admin-offline-v2';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            // cache: 'reload' skips the HTTP cache, so a new version of this
            // worker always stores the current offline page.
            .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

/*
 * Admin alerts (server/services/adminAlertService.js). Every push must show a
 * notification: Safari on iPhone stops delivering to a worker that receives a
 * push and shows nothing.
 */
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = { title: 'FIRA Admin', body: event.data ? event.data.text() : '' };
    }
    const title = payload.title || 'FIRA Admin';
    event.waitUntil(self.registration.showNotification(title, {
        body: payload.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        // One notification per kind: a newer alert replaces the older one.
        tag: payload.tag || undefined,
        renotify: Boolean(payload.tag),
        data: { url: payload.url || '/' },
    }));
});

/*
 * Tapping an alert opens its page. An admin window that is already open is
 * reused and moved to the page (navigate() only works on windows this worker
 * controls, so a failure falls back to opening a fresh window - on iPhone a
 * failed navigate otherwise left the tap doing nothing).
 */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = windows.find((w) => w.url.startsWith(self.location.origin));
        if (open) {
            try {
                const moved = open.url === target ? open : await open.navigate(target);
                if (moved) return moved.focus();
            } catch { /* fall through to a new window */ }
            try { await open.focus(); } catch { /* ignore */ }
        }
        return self.clients.openWindow(target);
    })());
});

self.addEventListener('fetch', (event) => {
    // Page loads only. Everything else (scripts, images, API calls) goes
    // straight to the network, untouched.
    if (event.request.mode !== 'navigate') return;
    event.respondWith(
        fetch(event.request).catch(() => caches.match(OFFLINE_URL))
    );
});
