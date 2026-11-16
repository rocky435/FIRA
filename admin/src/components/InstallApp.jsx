import { useEffect, useState } from 'react';
import { Download, Share, SquarePlus, MoreVertical } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { isInstalledApp, isIOS } from '../lib/device';

/**
 * "Install app" in the top bar, so nobody has to know the browser's own menu.
 *
 *  - Chrome / Edge / Android: the browser's install prompt (beforeinstallprompt).
 *  - iPhone / iPad: Safari has no prompt, so the button explains Share → Add to
 *    Home Screen. (On iPhone, notifications only work once installed this way.)
 *  - Already running as the installed app: the button is not shown.
 *  - Any other browser without a prompt: the steps for its menu.
 */

let deferredPrompt = null;
const listeners = new Set();
if (typeof window !== 'undefined') {
    // Captured at module load: the event can fire before any component mounts.
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        listeners.forEach((fn) => fn());
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        listeners.forEach((fn) => fn());
    });
}

export default function InstallApp() {
    const [, force] = useState(0);
    const [installed, setInstalled] = useState(isInstalledApp);
    const [helpOpen, setHelpOpen] = useState(false);

    useEffect(() => {
        const update = () => { force((n) => n + 1); setInstalled(isInstalledApp()); };
        listeners.add(update);
        const mq = window.matchMedia?.('(display-mode: standalone)');
        mq?.addEventListener?.('change', update);
        return () => { listeners.delete(update); mq?.removeEventListener?.('change', update); };
    }, []);

    if (installed) return null;

    const install = async () => {
        if (deferredPrompt) {
            const prompt = deferredPrompt;
            deferredPrompt = null;
            prompt.prompt();
            try { await prompt.userChoice; } catch { /* dismissed */ }
            force((n) => n + 1);
            return;
        }
        setHelpOpen(true);
    };

    const ios = isIOS();
    return (
        <>
            <Button size="sm" variant="secondary" onClick={install} leftIcon={<Download className="h-4 w-4" aria-hidden="true" />} className="hidden sm:inline-flex">
                Install app
            </Button>
            <button
                type="button"
                onClick={install}
                className="rounded-lg p-2 text-gray-300 hover:bg-hover hover:text-white sm:hidden"
                aria-label="Install FIRA Admin as an app"
            >
                <Download className="h-5 w-5" aria-hidden="true" />
            </button>

            <Modal
                open={helpOpen}
                onClose={() => setHelpOpen(false)}
                title="Install FIRA Admin"
                description={ios ? 'Add it to your Home Screen. On iPhone this is also what lets alerts reach you.' : 'Add it to your device like an app.'}
                footer={<Button onClick={() => setHelpOpen(false)}>Got it</Button>}
            >
                {ios ? (
                    <ol className="space-y-3 text-sm text-gray-200">
                        <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300"><Share className="h-4 w-4" aria-hidden="true" /></span>Open this page in <strong className="font-medium">Safari</strong> and tap the <strong className="font-medium">Share</strong> button.</li>
                        <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300"><SquarePlus className="h-4 w-4" aria-hidden="true" /></span>Scroll down and tap <strong className="font-medium">Add to Home Screen</strong>, then <strong className="font-medium">Add</strong>.</li>
                        <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300"><Download className="h-4 w-4" aria-hidden="true" /></span>Open <strong className="font-medium">FIRA Admin</strong> from your Home Screen and sign in.</li>
                    </ol>
                ) : (
                    <ol className="space-y-3 text-sm text-gray-200">
                        <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300"><MoreVertical className="h-4 w-4" aria-hidden="true" /></span>Open the browser menu (⋮ in Chrome and Edge).</li>
                        <li className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300"><Download className="h-4 w-4" aria-hidden="true" /></span>Choose <strong className="font-medium">Install FIRA Admin</strong> (or <strong className="font-medium">Add to Home screen</strong> on Android).</li>
                        <li className="text-gray-400">If there is no install option, the page may be open in a private window or a browser that cannot install apps. Use Chrome, Edge or Safari.</li>
                    </ol>
                )}
            </Modal>
        </>
    );
}
