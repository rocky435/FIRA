import { useCallback, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { ConfirmContext } from './confirmContext';

/**
 * In-app replacement for window.confirm.
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Block this user?', confirmLabel: 'Block', tone: 'danger' }))) return;
 *
 * Resolves true on confirm, false on cancel / Escape / backdrop. The native
 * dialog looked different on every OS, could not say what would happen in any
 * detail, and gave no protection against a reflex "OK" on a permanent delete.
 *
 * `requireText`: the confirm button stays disabled until that exact text is
 * typed (used for permanent deletes, e.g. the user's email).
 *
 * The hook lives in confirmContext.js.
 */

export function ConfirmProvider({ children }) {
    const [request, setRequest] = useState(null);
    const [typed, setTyped] = useState('');
    const resolverRef = useRef(null);

    const confirm = useCallback((options) => new Promise((resolve) => {
        // A second confirm while one is open answers the first with "no".
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setTyped('');
        setRequest(typeof options === 'string' ? { title: options } : options);
    }), []);

    const settle = useCallback((answer) => {
        resolverRef.current?.(answer);
        resolverRef.current = null;
        setRequest(null);
    }, []);

    const needsText = request?.requireText;
    const canConfirm = !needsText || typed.trim() === String(needsText).trim();

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <Modal
                open={!!request}
                onClose={() => settle(false)}
                title={request?.title || 'Are you sure?'}
                description={request?.message}
                size="sm"
                footer={
                    <>
                        <Button variant="secondary" onClick={() => settle(false)}>
                            {request?.cancelLabel || 'Cancel'}
                        </Button>
                        <Button
                            variant={request?.tone === 'danger' ? 'danger' : 'primary'}
                            onClick={() => settle(true)}
                            disabled={!canConfirm}
                        >
                            {request?.confirmLabel || 'Confirm'}
                        </Button>
                    </>
                }
            >
                {needsText && (
                    <form onSubmit={(e) => { e.preventDefault(); if (canConfirm) settle(true); }}>
                        <label className="block text-sm text-gray-300">
                            Type <span className="font-mono text-white">{needsText}</span> to confirm
                            <input
                                autoFocus
                                value={typed}
                                onChange={(e) => setTyped(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                className="mt-2 h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-white focus:border-red-500/60 focus:outline-none focus:ring-2 focus:ring-red-500/30"
                            />
                        </label>
                    </form>
                )}
            </Modal>
        </ConfirmContext.Provider>
    );
}
