import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '../../lib/cn';

const ACCENTS = {
    violet: 'text-violet-300 bg-violet-500/10',
    amber: 'text-amber-300 bg-amber-500/10',
    pink: 'text-pink-300 bg-pink-500/10',
    blue: 'text-blue-300 bg-blue-500/10',
    green: 'text-green-300 bg-green-500/10',
    red: 'text-red-300 bg-red-500/10',
};

/**
 * One headline number. With `to`, the whole card is a link - the dashboard's
 * cards used to look clickable (pointer cursor, hover lift) but went nowhere.
 */
export function StatCard({ label, value, hint, icon: Icon, accent = 'violet', to, children }) {
    const body = (
        <>
            <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 text-sm text-gray-400">{label}</span>
                {Icon && (
                    <span className={cn('hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:flex', ACCENTS[accent] || ACCENTS.violet)}>
                        <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
                    </span>
                )}
            </div>
            <div className="mt-2 truncate text-xl font-semibold tabular-nums text-white sm:text-2xl">{value}</div>
            {/* Extra content under the figure, e.g. a sold-out bar. */}
            {children}
            {(hint || to) && (
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                    <span>{hint}</span>
                    {to && <ArrowRight className="w-4 h-4 text-gray-500 transition-transform group-hover:translate-x-0.5 group-hover:text-white" aria-hidden="true" />}
                </div>
            )}
        </>
    );

    const base = 'group block min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5';
    return to ? (
        <Link to={to} className={cn(base, 'transition-colors hover:border-line-strong hover:bg-surface-raised')}>
            {body}
        </Link>
    ) : (
        <div className={base}>{body}</div>
    );
}
