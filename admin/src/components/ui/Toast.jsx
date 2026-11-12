import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleAlert, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ToastContext } from './toastContext';

/**
 * Short status messages in the corner: "User blocked", "Could not delete…".
 * Use them through useToast() (toastContext.js).
 *
 * Replaces alert() for errors and, more importantly, the many actions that
 * failed silently with only a console.error. Errors stay 8s, successes 4s, and
 * either can be dismissed. Announced to screen readers.
 */
const STYLES = {
    success: { icon: CircleCheck, className: 'text-green-400' },
    error: { icon: CircleAlert, className: 'text-red-400' },
    info: { icon: Info, className: 'text-blue-300' },
};

let nextId = 1;

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const timers = useRef(new Map());

    const dismiss = useCallback((id) => {
        setToasts((list) => list.filter((t) => t.id !== id));
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
    }, []);

    const push = useCallback((kind, message) => {
        if (!message) return;
        const id = nextId++;
        setToasts((list) => [...list.slice(-3), { id, kind, message }]);
        timers.current.set(id, setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000));
    }, [dismiss]);

    useEffect(() => {
        const map = timers.current;
        return () => map.forEach(clearTimeout);
    }, []);

    // Stable object, so pages can list `toast` as an effect dependency safely.
    const api = useMemo(() => ({
        success: (m) => push('success', m),
        error: (m) => push('error', m),
        info: (m) => push('info', m),
    }), [push]);

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div
                aria-live="polite"
                aria-atomic="false"
                className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
            >
                {toasts.map((t) => {
                    const { icon: Icon, className } = STYLES[t.kind] || STYLES.info;
                    return (
                        <div
                            key={t.id}
                            role={t.kind === 'error' ? 'alert' : 'status'}
                            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line-strong bg-surface-raised px-4 py-3 text-sm text-white shadow-2xl animate-toast-in"
                        >
                            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden="true" />
                            <span className="flex-1 break-words">{t.message}</span>
                            <button
                                type="button"
                                onClick={() => dismiss(t.id)}
                                className="-mr-1 rounded-md p-0.5 text-gray-400 hover:bg-hover hover:text-white"
                                aria-label="Dismiss"
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
}
