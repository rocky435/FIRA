/**
 * The admin dashboard's pager.
 *
 * This markup was copy-pasted into Users, Venues, Events and Brands, and the audit
 * trail had a cut-down version with only Previous/Next - so the one page you most want
 * to jump around in was the one you could only walk through. One component instead.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageWindow } from '../../lib/pageWindow';
import { cn } from '../../lib/cn';

export function Pagination({ currentPage, totalPages, onChange, className = '' }) {
    if (totalPages <= 1) return null;

    const go = page => {
        const next = Math.min(Math.max(1, page), totalPages);
        if (next !== currentPage) onChange(next);
    };

    const step = 'inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-gray-300 hover:bg-hover hover:text-white disabled:pointer-events-none disabled:opacity-40';

    return (
        <nav
            aria-label="Pagination"
            className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3', className)}
        >
            <span className="text-xs text-gray-500">Page {currentPage} of {totalPages}</span>
            <div className="flex flex-wrap items-center gap-1">
                <button type="button" onClick={() => go(currentPage - 1)} disabled={currentPage <= 1} className={step}>
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Previous</span>
                    <span className="sr-only sm:hidden">Previous page</span>
                </button>
                {pageWindow(currentPage, totalPages).map(page => (
                    <button
                        key={page}
                        type="button"
                        onClick={() => go(page)}
                        // aria-current is how a screen reader announces which page you are
                        // on; the fill only says it to people who can see it.
                        aria-current={currentPage === page ? 'page' : undefined}
                        aria-label={`Page ${page}`}
                        className={cn(
                            'h-8 min-w-8 rounded-lg px-2 text-sm font-medium tabular-nums transition-colors',
                            currentPage === page ? 'bg-white text-black' : 'text-gray-400 hover:bg-hover hover:text-white'
                        )}
                    >
                        {page}
                    </button>
                ))}
                <button type="button" onClick={() => go(currentPage + 1)} disabled={currentPage >= totalPages} className={step}>
                    <span className="hidden sm:inline">Next</span>
                    <span className="sr-only sm:hidden">Next page</span>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>
        </nav>
    );
}
