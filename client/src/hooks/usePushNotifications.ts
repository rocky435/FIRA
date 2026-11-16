'use client';

import { useCallback, useEffect, useState } from 'react';
import { notificationsApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Web Push subscription lifecycle.
 *
 * Flow: register the service worker -> ask the browser for permission ->
 * subscribe with our VAPID public key -> hand the subscription to the server so
 * it can push to this device later.
 *
 * Platform notes that shape this code:
 *  - iOS Safari only allows Web Push when the site is installed to the home
 *    screen (16.4+). `isSupported` will be false in a normal iOS tab, so the UI
 *    needs to explain that rather than silently hiding the toggle.
 *  - Permission is per-origin and cannot be re-prompted once denied; the user
 *    has to change it in browser settings. Hence the distinct 'denied' state.
 */

// The key the server signs pushes with. Read from the server rather than baked
// into the build: a build-time copy (NEXT_PUBLIC_VAPID_PUBLIC_KEY) that differs
// from the server's - e.g. after the keys were rotated - makes every push fail
// while the toggle still says "on". The env value is only a fallback for when
// the server cannot be asked.
const BUILD_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
let keyRequest: Promise<string> | null = null;
function serverKey(): Promise<string> {
    if (!keyRequest) {
        keyRequest = notificationsApi.getPushPublicKey()
            .then((r) => r.publicKey || BUILD_KEY)
            .catch(() => {
                keyRequest = null; // ask again next time
                return BUILD_KEY;
            });
    }
    return keyRequest;
}

/**
 * Make sure this browser has a subscription made with the server's current key,
 * and that the server has it. Replaces a stale one. Needs permission already
 * granted; returns null when there is no usable key.
 */
async function ensureSubscription(registration: ServiceWorkerRegistration): Promise<PushSubscription | null> {
    const key = await serverKey();
    if (!key) return null;
    const applicationServerKey = urlBase64ToUint8Array(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !keyMatches(subscription, applicationServerKey)) {
        await subscription.unsubscribe().catch(() => undefined);
        subscription = null;
    }
    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey as BufferSource,
        });
    }
    await notificationsApi.subscribePush(subscription.toJSON());
    return subscription;
}

/** VAPID keys are base64url; PushManager wants a Uint8Array. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        output[i] = raw.charCodeAt(i);
    }
    return output;
}

/**
 * Does an existing subscription use the VAPID key we are configured with?
 * If not it is stale and the server can never deliver to it.
 */
function keyMatches(subscription: PushSubscription, expected: Uint8Array): boolean {
    const actual = subscription.options?.applicationServerKey;
    if (!actual) return false;

    const bytes = new Uint8Array(actual as ArrayBuffer);
    if (bytes.length !== expected.length) return false;
    return bytes.every((byte, i) => byte === expected[i]);
}

export type PushPermission = 'default' | 'granted' | 'denied';

export function usePushNotifications() {
    const { isAuthenticated } = useAuth();
    const [isSupported, setIsSupported] = useState(false);
    const [permission, setPermission] = useState<PushPermission>('default');
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Detect support and read the current subscription state on mount.
    useEffect(() => {
        const supported =
            typeof window !== 'undefined' &&
            'serviceWorker' in navigator &&
            'PushManager' in window &&
            'Notification' in window;

        setIsSupported(supported);
        if (!supported) return;

        setPermission(Notification.permission as PushPermission);

        navigator.serviceWorker
            .getRegistration()
            .then(async (reg) => {
                const sub = await reg?.pushManager.getSubscription();
                setIsSubscribed(Boolean(sub));

                // Re-sync this browser with the server.
                //
                // The toggle used to read the browser only, so it showed "on"
                // while the server had no matching record - and pushes had
                // nowhere to go. That happens when the record was created under a
                // different account, pruned as expired, or lost. Phones (iPhones
                // especially) also drop the subscription itself while permission
                // stays granted, which silently stopped every notification.
                //
                // So with permission granted: replace a missing or stale
                // subscription and hand it to the server (the endpoint upserts,
                // which also re-points the device at whoever is signed in now).
                if (reg && isAuthenticated && Notification.permission === 'granted') {
                    const fresh = await ensureSubscription(reg).catch(() => null);
                    if (fresh) setIsSubscribed(true);
                }
            })
            .catch(() => setIsSubscribed(false));
    }, [isAuthenticated]);

    const subscribe = useCallback(async () => {
        setError(null);

        if (!isSupported) {
            setError('This browser does not support push notifications.');
            return false;
        }
        if (!isAuthenticated) {
            setError('Sign in to enable notifications.');
            return false;
        }

        setIsBusy(true);
        try {
            // Ask for permission FIRST, before any await.
            //
            // Mobile browsers (Chrome on Android especially) require
            // requestPermission() to run inside the user-gesture that started
            // the interaction. Awaiting the service worker registration first
            // spends that gesture, so the call was being rejected outright -
            // which is why the prompt appeared but enabling then failed.
            const result = await Notification.requestPermission();
            setPermission(result as PushPermission);

            if (result !== 'granted') {
                setError(
                    result === 'denied'
                        ? 'Notifications are blocked. Enable them for this site in your browser settings, then reload.'
                        : 'Permission was dismissed. Tap again to retry.'
                );
                return false;
            }

            await navigator.serviceWorker.register('/sw.js');
            // A freshly-registered worker may still be installing; pushManager
            // is only usable once one is active.
            const registration = await navigator.serviceWorker.ready;

            // Subscribes with the server's current key, dropping a subscription
            // made with an old one (re-subscribing with a different key throws,
            // and a stale one can never be delivered to).
            const subscription = await ensureSubscription(registration);
            if (!subscription) {
                setError('Push notifications are not set up on the server yet.');
                return false;
            }
            setIsSubscribed(true);
            return true;
        } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            // Browser errors here are opaque ("Registration failed - push
            // service error"), so translate the common ones.
            let message = raw;
            if (/permission/i.test(raw)) {
                message = 'Notification permission was refused for this site.';
            } else if (/push service|AbortError|Registration failed/i.test(raw)) {
                message =
                    'Your browser could not reach its push service. This is usually a network or Google Play Services issue - try again on a different network.';
            } else if (/applicationServerKey|InvalidAccessError/i.test(raw)) {
                message = 'Push key mismatch. Turn notifications off and on again to re-register this device.';
            }
            setError(message);
            return false;
        } finally {
            setIsBusy(false);
        }
    }, [isSupported, isAuthenticated]);

    const unsubscribe = useCallback(async () => {
        setError(null);
        if (!isSupported) return false;

        setIsBusy(true);
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            const subscription = await registration?.pushManager.getSubscription();

            if (subscription) {
                // Tell the server first: if the browser unsubscribes but the
                // request fails, we would keep pushing to a dead endpoint until
                // it 410s.
                await notificationsApi.unsubscribePush(subscription.endpoint).catch(() => undefined);
                await subscription.unsubscribe();
            }

            setIsSubscribed(false);
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not turn off notifications.');
            return false;
        } finally {
            setIsBusy(false);
        }
    }, [isSupported]);

    const sendTest = useCallback(async () => {
        setError(null);
        try {
            await notificationsApi.sendTestPush();
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not send a test notification.');
            return false;
        }
    }, []);

    return {
        isSupported,
        permission,
        isSubscribed,
        isBusy,
        error,
        subscribe,
        unsubscribe,
        sendTest,
    };
}
