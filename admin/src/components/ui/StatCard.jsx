import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useCountUp } from '../../lib/useCountUp';

const ACCENTS = {
    violet: 'text-violet-300 bg-violet-500/15',
    amber: 'text-amber-300 bg-amber-500/15',
    pink: 'text-pink-300 bg-pink-500/15',
    blue: 'text-sky-300 bg-sky-500/15',
    green: 'text-emerald-300 bg-emerald-500/15',
    red: 'text-red-300 bg-red-500/15',
};

/** A number that counts up, formatted the way the caller wants (₹, commas). */
function CountUp({ to, format }) {
    const value = useCountUp(to);
    return format(value);
}

/**
 * Change against the previous period, as a coloured pill: green up, amber down,
 * grey for no change. `trend` is a percentage (12.5 = +12.5%), or null to hide.
 */
export function TrendPill({ trend, className = '' }) {
    if (trend == null || !Number.isFinite(trend)) return null;
    const flat = Math.abs(trend) < 0.05;
    const up = trend > 0;
    const Icon = up ? ArrowUp : ArrowDown;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                flat ? 'bg-white/10 text-gray-300' : up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300',
                className
            )}
            title="Compared with last month"
        >
            {!flat && <Icon className="h-3 w-3" aria-hidden="true" />}
            {/* A jump from a tiny last month reads as a huge %; past 999 the exact figure says nothing. */}
            {flat ? '0%' : Math.abs(trend) > 999 ? '999%+' : `${Math.abs(trend) >= 100 ? Math.round(Math.abs(trend)) : Math.abs(trend).toFixed(1)}%`}
            <span className="sr-only">{flat ? 'no change' : up ? 'up' : 'down'} on last month</span>
        </span>
    );
}

/**
 * One headline number, in the dashboard style: an icon and label on top, the
 * figure below with an optional trend pill, and a hint line. With `to`, the
 * whole card is a link. Pass `countTo` (a number) and `format` to have the
 * figure count up instead of a fixed `value`.
 */
export function StatCard({ label, value, countTo, format = (n) => Math.round(n).toLocaleString('en-IN'), hint, icon: Icon, accent = 'violet', to, trend, children }) {
    const figure = Number.isFinite(countTo) ? <CountUp to={countTo} format={format} /> : value;
    const body = (
        <>
            <div className="flex items-center gap-2.5">
                {Icon && (
                    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', ACCENTS[accent] || ACCENTS.violet)}>
                        <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                )}
                {/* Two lines on a phone rather than "Collected t…"; one line from tablet up. */}
                <span className="min-w-0 line-clamp-2 text-sm font-medium leading-snug text-gray-300 sm:truncate">{label}</span>
                {to && <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-gray-600 transition-transform group-hover:translate-x-0.5 group-hover:text-white" aria-hidden="true" />}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-2xl font-semibold tabular-nums tracking-tight text-white sm:text-[1.7rem]">{figure}</span>
                <TrendPill trend={trend} />
            </div>
            {/* Extra content under the figure, e.g. a sold-out bar. */}
            {children}
            {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
        </>
    );

    const base = 'group lift block min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5';
    return to ? (
        <Link to={to} className={cn(base, 'hover:bg-surface-raised')}>
            {body}
        </Link>
    ) : (
        <div className={base}>{body}</div>
    );
}
