import { useId, useState } from 'react';
import { cn } from '../../lib/cn';
import { niceCeiling, wholeCeiling } from '../../lib/niceCeiling';

/**
 * A small bar chart in the dashboard style: past periods as soft striped bars,
 * the latest one in the brand gradient, with a tooltip on hover or keyboard
 * focus. Bars grow up from the axis when the chart first shows.
 *
 * `data` is [{ label, value, detail? }], oldest first. `format` turns a value
 * into text (₹, commas). The y-axis has four steps from 0 to a round number at
 * or above the largest value, so every label is a value the chart can reach.
 * `steps` 2 gives a short chart (0, half, top) for a pair of small charts.
 */
export function BarChart({ data = [], format = (n) => n.toLocaleString('en-IN'), axisFormat, height = 180, label, wholeNumbers = false, steps = 4 }) {
    const id = useId();
    const [active, setActive] = useState(null);
    const max = Math.max(0, ...data.map((d) => d.value || 0));
    // Counts (people, tickets) get an axis whose four steps are whole numbers.
    const top = wholeNumbers ? wholeCeiling(max) : niceCeiling(max);
    const ticks = Array.from({ length: steps + 1 }, (_, i) => (top * (steps - i)) / steps);
    const fmtAxis = axisFormat || format;
    const last = data.length - 1;
    // A year of months does not fit a phone: tighter bars, and every other
    // month label (the latest always shown) until the screen is wider.
    const dense = data.length > 8;
    const gap = dense ? 'gap-1 sm:gap-2' : 'gap-2 sm:gap-3';

    return (
        <figure className="w-full" aria-label={label}>
            <div className="flex gap-3">
                {/* y-axis */}
                {/* Each label centred on its gridline (the top one hangs below it,
                    the bottom one sits above it, so neither spills out). Spacing them
                    with justify-between put the middle ones off their lines in a
                    short chart. A hidden copy of the widest label sets the width. */}
                <div className="relative shrink-0 text-right text-[11px] tabular-nums text-gray-500" style={{ height }} aria-hidden="true">
                    <span className="invisible block h-0 overflow-hidden">{fmtAxis(top)}</span>
                    {ticks.map((t, i) => (
                        <span
                            key={i}
                            className="absolute right-0 whitespace-nowrap leading-none"
                            style={{ top: `${(i / steps) * 100}%`, transform: `translateY(${i === 0 ? '0' : i === steps ? '-100%' : '-50%'})` }}
                        >
                            {fmtAxis(t)}
                        </span>
                    ))}
                </div>
                <div className="relative min-w-0 flex-1">
                    {/* grid lines */}
                    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
                        {ticks.map((_, i) => <div key={i} className="border-t border-dashed border-white/[0.06]" />)}
                    </div>
                    <ul className={cn('relative flex items-end', gap)} style={{ height }}>
                        {data.map((d, i) => {
                            const pct = top > 0 ? Math.max(d.value > 0 ? 2 : 0, (d.value / top) * 100) : 0;
                            const isLast = i === last;
                            const shown = active === i;
                            // Near an edge the tooltip lines up with that edge rather
                            // than centring on the bar, so it is never cut off on a phone.
                            const align = i < data.length / 3 ? 'left-0' : i >= (data.length * 2) / 3 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                            return (
                                <li key={d.label} className="relative flex h-full flex-1 items-end justify-center">
                                    {shown && (
                                        <div role="tooltip" id={`${id}-tip-${i}`} className={cn('absolute bottom-full z-10 mb-2 w-max max-w-[12rem] rounded-lg border border-line-strong bg-surface-raised px-2.5 py-1.5 text-xs shadow-xl animate-fade-in', align)}
                                            style={{ bottom: `calc(${pct}% + 0.5rem)` }}>
                                            <p className="font-medium text-white">{d.label}: {format(d.value)}</p>
                                            {d.detail && <p className="mt-0.5 text-gray-400">{d.detail}</p>}
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        className={cn(
                                            'bar-grow w-full max-w-[3.25rem] rounded-t-lg outline-none transition-[filter] focus-visible:ring-2 focus-visible:ring-violet-300',
                                            isLast ? 'bg-brand-grad shadow-lg shadow-violet-900/40' : 'bar-hatch',
                                            shown && 'brightness-125'
                                        )}
                                        style={{ height: `${pct}%`, animationDelay: `${i * 60}ms` }}
                                        onMouseEnter={() => setActive(i)}
                                        onMouseLeave={() => setActive(null)}
                                        onFocus={() => setActive(i)}
                                        onBlur={() => setActive(null)}
                                        aria-label={`${d.label}: ${format(d.value)}${d.detail ? `, ${d.detail}` : ''}`}
                                        aria-describedby={shown ? `${id}-tip-${i}` : undefined}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                    {/* x-axis */}
                    <ul className={cn('mt-2 flex', gap)} aria-hidden="true">
                        {data.map((d, i) => (
                            <li key={d.label} className={cn('flex-1 whitespace-nowrap text-center text-xs', i === last ? 'font-medium text-white' : 'text-gray-500')}>
                                <span className={dense && i !== last && (last - i) % 2 === 1 ? 'invisible sm:visible' : undefined}>{d.label}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </figure>
    );
}

