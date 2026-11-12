import { X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Sticky bar that appears when rows are selected, offering bulk actions.
 *
 * Shown only when count > 0, so it never occupies space in the resting state.
 * Each action is { label, onClick, variant } - variant 'danger' tints it red for
 * destructive operations (delete/block). The caller owns the confirm dialog and
 * the API calls; this is purely the presentation of "N selected + these buttons".
 */
export default function BulkActionBar({ count, actions = [], onClear, busy = false }) {
    if (count === 0) return null;

    return (
        <div
            role="region"
            aria-label="Bulk actions"
            className="sticky top-16 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-500/30 bg-surface-raised px-3 py-2 shadow-lg lg:top-20"
        >
            <span className="px-1 text-sm font-medium text-white">
                {count} selected
            </span>
            <div className="flex-1" />
            {actions.map((action) => (
                <button
                    key={action.label}
                    type="button"
                    onClick={action.onClick}
                    disabled={busy}
                    className={cn(
                        'h-8 rounded-lg px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        action.variant === 'danger'
                            ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
                            : 'bg-white/[0.08] text-white hover:bg-white/[0.14]'
                    )}
                >
                    {action.label}
                </button>
            ))}
            <button
                type="button"
                onClick={onClear}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-gray-400 transition-colors hover:bg-hover hover:text-white disabled:opacity-50"
            >
                <X className="h-4 w-4" aria-hidden="true" />
                Clear
            </button>
        </div>
    );
}
