import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing, BellOff, Send, CircleCheck, TriangleAlert, Share, SquarePlus } from 'lucide-react';
import adminApi from '../api/adminApi';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { isInstalledApp, isIOS } from '../lib/device';

/**
 * Alerts on this device: a bell in the top bar that turns admin alerts on or off
 * for this phone or computer, sends a test, and says plainly why it cannot when
 * it cannot (iPhone not installed, permission blocked, server not set up).
 *
 * Reliability, the part that failed before on iPhone:
 *  - the key comes from the server each time, so it can never differ from the
 *    one the server sends with;
 *  - each time the admin opens, a subscription the phone dropped (iPhones do)
 *    is quietly replaced, as long as permission is still granted;
 *  - the test shows what Apple or Google actually answered.
 */

const supported = () =>
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(subscription, expected) {
    const actual = subscription?.options?.applicationServerKey;
    if (!actual) return false;
    const bytes = new Uint8Array(actual);
    return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}

/** Subscribe (or re-subscribe) this device and tell the server. */
async function ensureSubscribed() {
    const { publicKey } = await adminApi.getAlertsKey();
    const key = keyBytes(publicKey);
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    let sub = await registration.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
    }
    if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await adminApi.subscribeAlerts(sub.toJSON());
    return sub;
}

function explain(err) {
    const raw = err?.message || String(err);
    if (/VAPID|not set up/i.test(raw)) return 'Alerts are not set up on the server yet (VAPID keys missing).';
    if (/push service|AbortError|Registration failed/i.test(raw)) return "This device couldn't reach its push service. Check the connection and try again.";
    if (/permission|denied|NotAllowed/i.test(raw)) return 'Notifications are blocked for this site. Allow them in the browser or phone settings, then try again.';
    return raw;
}

export default function AlertsControl() {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState('checking'); // checking | unsupported | ios-install | denied | off | on
    const [busy, setBusy] = useState(null);
    const [message, setMessage] = useState(null); // { tone: 'ok' | 'error', text, details? }

    const check = useCallback(async () => {
        if (!supported()) {
            setState(isIOS() && !isInstalledApp() ? 'ios-install' : 'unsupported');
            return;
        }
        if (Notification.permission === 'denied') { setState('denied'); return; }
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            const sub = await registration?.pushManager.getSubscription();
            if (Notification.permission === 'granted') {
                // Permission is there: make sure the subscription is too, and that
                // the server has it. Replaces one the phone dropped, silently.
                await ensureSubscribed();
                setState('on');
            } else {
                setState(sub ? 'on' : 'off');
            }
        } catch {
            setState(Notification.permission === 'granted' ? 'off' : 'off');
        }
    }, []);

    useEffect(() => {
        // Checked once when the admin opens, and again when it comes back to the front.
        const id = requestAnimationFrame(() => { check(); });
        const onVisible = () => { if (!document.hidden) check(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { cancelAnimationFrame(id); document.removeEventListener('visibilitychange', onVisible); };
    }, [check]);

    const turnOn = async () => {
        setBusy('on');
        setMessage(null);
        try {
            // Asked first, inside the tap: phones refuse the prompt after an await.
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                setState(permission === 'denied' ? 'denied' : 'off');
                setMessage({ tone: 'error', text: permission === 'denied' ? 'Notifications are blocked for this site.' : 'Permission was dismissed. Tap again to allow.' });
                return;
            }
            await ensureSubscribed();
            setState('on');
            await sendTest();
        } catch (err) {
            setMessage({ tone: 'error', text: explain(err) });
        } finally {
            setBusy(null);
        }
    };

    const turnOff = async () => {
        setBusy('off');
        setMessage(null);
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            const sub = await registration?.pushManager.getSubscription();
            if (sub) {
                await adminApi.unsubscribeAlerts(sub.endpoint).catch(() => {});
                await sub.unsubscribe();
            }
            setState('off');
            setMessage({ tone: 'ok', text: 'Alerts are off for this device.' });
        } catch (err) {
            setMessage({ tone: 'error', text: explain(err) });
        } finally {
            setBusy(null);
        }
    };

    const sendTest = async () => {
        setBusy((b) => b || 'test');
        try {
            const result = await adminApi.testAlerts();
            const delivered = (result.results || []).filter((r) => r.ok);
            setMessage({
                tone: 'ok',
                text: `Test sent to ${delivered.length} ${delivered.length === 1 ? 'device' : 'devices'}. It should appear in a few seconds.`,
                details: result.results,
            });
        } catch (err) {
            setMessage({ tone: 'error', text: explain(err), details: err?.body?.results });
        } finally {
            setBusy((b) => (b === 'test' ? null : b));
        }
    };

    const Icon = state === 'on' ? BellRing : state === 'denied' ? BellOff : Bell;
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="relative rounded-lg p-2 text-gray-300 hover:bg-hover hover:text-white"
                aria-label={state === 'on' ? 'Alerts are on for this device' : 'Turn on alerts'}
                title={state === 'on' ? 'Alerts on' : 'Alerts'}
            >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {state === 'on' && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-background" aria-hidden="true" />}
            </button>

            <Modal
                open={open}
                onClose={() => setOpen(false)}
                title="Alerts on this device"
                description="New venues, events and creators to review, ID checks, refunds and removal requests."
                footer={<Button variant="ghost" onClick={() => setOpen(false)}>Done</Button>}
            >
                <div className="space-y-4 text-sm">
                    {state === 'checking' && <p className="text-gray-400">Checking this device…</p>}

                    {state === 'ios-install' && (
                        <div className="space-y-3">
                            <p className="text-gray-200">On iPhone, alerts work only when FIRA Admin is installed on the Home Screen.</p>
                            <ol className="space-y-2 text-gray-300">
                                <li className="flex items-center gap-2"><Share className="h-4 w-4 text-violet-300" aria-hidden="true" />In Safari, tap <strong className="font-medium text-white">Share</strong>.</li>
                                <li className="flex items-center gap-2"><SquarePlus className="h-4 w-4 text-violet-300" aria-hidden="true" />Tap <strong className="font-medium text-white">Add to Home Screen</strong>.</li>
                                <li className="flex items-center gap-2"><Bell className="h-4 w-4 text-violet-300" aria-hidden="true" />Open it from the Home Screen, sign in, and turn alerts on here.</li>
                            </ol>
                            <p className="text-xs text-gray-500">Needs iOS 16.4 or later.</p>
                        </div>
                    )}

                    {state === 'unsupported' && <p className="text-gray-300">This browser can&apos;t show alerts. Use Chrome, Edge, Firefox, or the installed app on iPhone.</p>}

                    {state === 'denied' && (
                        <p className="text-gray-300">
                            Notifications are blocked for this site. Allow them in {isIOS() ? 'Settings → Notifications → FIRA Admin' : 'the site settings (the icon left of the address)'}, then open this again.
                        </p>
                    )}

                    {state === 'off' && (
                        <div className="space-y-3">
                            <p className="text-gray-300">Alerts are off for this device.</p>
                            <Button onClick={turnOn} isLoading={busy === 'on'} leftIcon={<BellRing className="h-4 w-4" aria-hidden="true" />}>Turn on alerts</Button>
                        </div>
                    )}

                    {state === 'on' && (
                        <div className="space-y-3">
                            <p className="flex items-center gap-2 text-emerald-300"><CircleCheck className="h-4 w-4" aria-hidden="true" />Alerts are on for this device.</p>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="secondary" onClick={sendTest} isLoading={busy === 'test'} disabled={Boolean(busy)} leftIcon={<Send className="h-4 w-4" aria-hidden="true" />}>Send a test</Button>
                                <Button variant="ghost" onClick={turnOff} isLoading={busy === 'off'} disabled={Boolean(busy)} leftIcon={<BellOff className="h-4 w-4" aria-hidden="true" />}>Turn off</Button>
                            </div>
                        </div>
                    )}

                    {message && (
                        <div role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3' : 'rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3'}>
                            <p className={message.tone === 'error' ? 'flex items-start gap-2 text-red-200' : 'flex items-start gap-2 text-emerald-200'}>
                                {message.tone === 'error' ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                                {message.text}
                            </p>
                            {Array.isArray(message.details) && message.details.length > 0 && (
                                <ul className="mt-2 space-y-1 text-xs text-gray-400">
                                    {message.details.map((d, i) => (
                                        <li key={i}>
                                            {d.service}: {d.ok ? `accepted (${d.status})` : `refused${d.status ? ` (${d.status})` : ''} - ${d.reason}${d.removed ? ' · this device was removed; turn alerts on again' : ''}`}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            </Modal>
        </>
    );
}
