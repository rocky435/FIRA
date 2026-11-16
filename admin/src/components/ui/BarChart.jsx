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
 */
export function BarChart({ data = [], format = (n) => n.toLocaleString('en-IN'), axisFormat, height = 180, label, wholeNumbers = false }) {
    const id = useId();
    const [active, setActive] = useState(null);
    const max = Math.max(0, ...data.map((d) => d.value || 0));
    // Counts (people, tickets) get an axis whose four steps are whole numbers.
    const top = wholeNumbers ? wholeCeiling(max) : niceCeiling(max);
    const ticks = [top, (top * 3) / 4, top / 2, top / 4, 0];
    const fmtAxis = axisFormat || format;
    const last = data.length - 1;

    return (
        <figure className="w-full" aria-label={label}>
            <div className="flex gap-3">
                {/* y-axis */}
                <div className="flex shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-gray-500" style={{ height }} aria-hidden="true">
                    {ticks.map((t, i) => <span key={i} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">{fmtAxis(t)}</span>)}
                </div>
                <div className="relative min-w-0 flex-1">
                    {/* grid lines */}
                    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
                        {ticks.map((_, i) => <div key={i} className="border-t border-dashed border-white/[0.06]" />)}
                    </div>
                    <ul className="relative flex items-end gap-2 sm:gap-3" style={{ height }}>
                        {data.map((d, i) => {
                            const pct = top > 0 ? Math.max(d.value > 0 ? 2 : 0, (d.value / top) * 100) : 0;
                            const isLast = i === last;
                            const shown = active === i;
                            return (
                                <li key={d.label} className="relative flex h-full flex-1 items-end justify-center">
                                    {shown && (
                                        <div role="tooltip" id={`${id}-tip-${i}`} className="absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-[12rem] -translate-x-1/2 rounded-lg border border-line-strong bg-surface-raised px-2.5 py-1.5 text-xs shadow-xl animate-fade-in"
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
                    <ul className="mt-2 flex gap-2 sm:gap-3" aria-hidden="true">
                        {data.map((d, i) => (
                            <li key={d.label} className={cn('flex-1 text-center text-xs', i === last ? 'font-medium text-white' : 'text-gray-500')}>{d.label}</li>
                        ))}
                    </ul>
                </div>
            </div>
        </figure>
    );
}

