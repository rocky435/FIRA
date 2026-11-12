import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog.
 *
 * The admin's only previous modal (Events' reject dialog) had no Escape key, no
 * focus handling and no dialog role, so a keyboard or screen-reader user could
 * not tell it had opened or get back out. This one:
 *   - is announced as a dialog, labelled by its title
 *   - moves focus inside on open and returns it to the trigger on close
 *   - keeps Tab inside the dialog
 *   - closes on Escape and on a backdrop click (unless `dismissible` is false,
 *     e.g. while a request is in flight)
 *   - locks page scroll behind it
 */
export function Modal({ open, onClose, title, description, children, footer, size = 'md', dismissible = true, initialFocusRef }) {
    const panelRef = useRef(null);
    const titleId = useId();
    const descId = useId();
    // Held in refs so a parent passing a fresh arrow function each render does
    // not re-run the open effect (which would yank focus back to the first field).
    const onCloseRef = useRef(onClose);
    const dismissibleRef = useRef(dismissible);
    useEffect(() => { onCloseRef.current = onClose; dismissibleRef.current = dismissible; });

    useEffect(() => {
        if (!open) return undefined;
        const previouslyFocused = document.activeElement;
        const { overflow } = document.body.style;
        document.body.style.overflow = 'hidden';

        const focusFirst = () => {
            const target = initialFocusRef?.current || panelRef.current?.querySelector(FOCUSABLE) || panelRef.current;
            target?.focus();
        };
        const raf = requestAnimationFrame(focusFirst);

        const onKey = (e) => {
            if (e.key === 'Escape' && dismissibleRef.current) {
                e.stopPropagation();
                onCloseRef.current?.();
                return;
            }
            if (e.key !== 'Tab' || !panelRef.current) return;
            const nodes = [...panelRef.current.querySelectorAll(FOCUSABLE)];
            if (nodes.length === 0) { e.preventDefault(); return; }
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);

        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('keydown', onKey, true);
            document.body.style.overflow = overflow;
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
        };
    }, [open, initialFocusRef]);

    if (!open) return null;

    const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' };

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4">
            <div
                className="absolute inset-0 bg-black/70 animate-fade-in"
                onClick={dismissible ? onClose : undefined}
                aria-hidden="true"
            />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descId : undefined}
                tabIndex={-1}
                className={cn(
                    'relative w-full rounded-t-2xl border border-line-strong bg-surface-raised shadow-2xl animate-slide-up sm:rounded-2xl',
                    'max-h-[90vh] overflow-y-auto focus:outline-none',
                    widths[size] || widths.md
                )}
            >
                <div className="flex items-start justify-between gap-4 px-5 pt-5">
                    <div className="min-w-0">
                        <h2 id={titleId} className="text-lg font-semibold text-white">{title}</h2>
                        {description && <p id={descId} className="mt-1 text-sm text-gray-400 whitespace-pre-line">{description}</p>}
                    </div>
                    {dismissible && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="-mr-1 rounded-lg p-1.5 text-gray-400 hover:bg-hover hover:text-white"
                            aria-label="Close"
                        >
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    )}
                </div>
                {children && <div className="px-5 pt-4">{children}</div>}
                {footer && <div className="flex flex-col-reverse gap-2 px-5 py-5 sm:flex-row sm:justify-end">{footer}</div>}
            </div>
        </div>,
        document.body
    );
}
