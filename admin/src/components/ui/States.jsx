import { Inbox, TriangleAlert, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

/**
 * Loading, empty and error states, so every page says the same thing the same way.
 *
 * Most list pages used to swallow a failed load with console.error and show an
 * empty table - indistinguishable from "there is genuinely nothing here".
 * ErrorState says it failed and offers Retry.
 */

export function Skeleton({ className = '' }) {
    return <div className={cn('skeleton rounded-md', className)} aria-hidden="true" />;
}

/** Placeholder rows for a table while it loads. */
export function TableSkeleton({ rows = 6, columns = 5 }) {
    return (
        <div className="divide-y divide-line" role="status" aria-label="Loading">
            {Array.from({ length: rows }).map((_, r) => (
                <div key={r} className="flex items-center gap-4 px-5 py-4">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    {Array.from({ length: columns - 1 }).map((__, c) => (
                        <Skeleton key={c} className={cn('h-3.5', c === 0 ? 'w-40' : 'w-20 hidden sm:block')} />
                    ))}
                </div>
            ))}
            <span className="sr-only">Loading…</span>
        </div>
    );
}

export function PageSkeleton() {
    return (
        <div className="space-y-6 p-4 sm:p-6 lg:p-8" role="status" aria-label="Loading">
            <div className="space-y-2">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-4 w-72" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
            </div>
            <Skeleton className="h-64 rounded-2xl" />
            <span className="sr-only">Loading…</span>
        </div>
    );
}

export function EmptyState({ icon = Inbox, title = 'Nothing here yet', message, action, className = '' }) {
    const Icon = icon;
    return (
        <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.05] text-gray-400">
                <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-white">{title}</p>
            {message && <p className="mt-1 max-w-sm text-sm text-gray-400">{message}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

export function ErrorState({ title = "Couldn't load this", message, onRetry, className = '' }) {
    return (
        <div role="alert" className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-500/10 text-red-400">
                <TriangleAlert className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-white">{title}</p>
            {message && <p className="mt-1 max-w-sm text-sm text-gray-400">{message}</p>}
            {onRetry && (
                <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
                    Try again
                </Button>
            )}
        </div>
    );
}
