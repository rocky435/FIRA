import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * Title row at the top of every page: title, a one-line description, an optional
 * count ("124 total"), an optional back link, and actions on the right.
 */
export function PageHeader({ title, description, count, backTo, backLabel = 'Back', actions, children }) {
    return (
        // A soft wash of the current area's colour (--section, set by the
        // layout) behind the title; decorative only.
        <div className="relative mb-6">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-10 -top-16 h-40 w-80 rounded-full opacity-[0.16] blur-3xl"
                style={{ background: 'radial-gradient(closest-side, var(--section), transparent)' }}
            />
            {backTo && (
                <Link
                    to={backTo}
                    className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                    {backLabel}
                </Link>
            )}
            <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
                    {(description || count != null) && (
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-gray-400">
                            {description && <span>{description}</span>}
                            {description && count != null && <span aria-hidden="true">·</span>}
                            {count != null && <span>{Number(count).toLocaleString('en-IN')} total</span>}
                        </p>
                    )}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
            <div className="relative">{children}</div>
        </div>
    );
}
