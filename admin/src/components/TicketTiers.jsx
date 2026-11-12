import { formatInr } from '../lib/formatInr';
import { eventTiers, tierTotals } from '../lib/ticketTiers';
import { cn } from '../lib/cn';

const priceLabel = (price) => (price > 0 ? formatInr(price) : 'Free');

/** "₹499" for one category, "₹499 – ₹1,999" for several. */
export function TierPriceRange({ event, className = '' }) {
    const totals = tierTotals(eventTiers(event));
    const range = totals.minPrice === totals.maxPrice
        ? priceLabel(totals.minPrice)
        : `${priceLabel(totals.minPrice)} – ${formatInr(totals.maxPrice)}`;
    return (
        <span className={className}>
            {range}
            {totals.count > 1 && <span className="text-gray-500"> · {totals.count} categories</span>}
        </span>
    );
}

function SoldBar({ sold, quantity }) {
    const pct = quantity > 0 ? Math.min(100, Math.round((sold / quantity) * 100)) : 0;
    return (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
            <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-amber-400' : 'bg-violet-400')} style={{ width: `${pct}%` }} />
        </div>
    );
}

/**
 * Every ticket category with its price, how many sold, how many are left and the
 * face value sold. `compact` is the short list used on the approval cards.
 */
export default function TicketTiers({ event, compact = false }) {
    const tiers = eventTiers(event);
    const totals = tierTotals(tiers);

    if (compact) {
        return (
            <ul className="space-y-1.5" aria-label="Ticket categories">
                {tiers.map((t) => (
                    <li key={t.key} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate text-gray-300">{t.name}</span>
                        <span className="shrink-0 tabular-nums text-white">
                            {priceLabel(t.price)}
                            <span className="text-gray-500"> × {t.quantity.toLocaleString('en-IN')}</span>
                        </span>
                    </li>
                ))}
            </ul>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-label="Ticket categories">
                <thead className="border-b border-line">
                    <tr>
                        <th scope="col" className="px-5 py-3 text-xs font-medium uppercase tracking-wide text-gray-400">Category</th>
                        <th scope="col" className="px-5 py-3 text-xs font-medium uppercase tracking-wide text-gray-400">Price</th>
                        <th scope="col" className="px-5 py-3 text-xs font-medium uppercase tracking-wide text-gray-400">Sold</th>
                        <th scope="col" className="px-5 py-3 text-xs font-medium uppercase tracking-wide text-gray-400">Left</th>
                        <th scope="col" className="px-5 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-400">Sold value</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-line">
                    {tiers.map((t) => {
                        const left = Math.max(0, t.quantity - t.sold);
                        return (
                            <tr key={t.key}>
                                <td className="px-5 py-3 align-top">
                                    <p className="font-medium text-white">{t.name}</p>
                                    {t.description && <p className="mt-0.5 max-w-xs whitespace-normal text-xs text-gray-400">{t.description}</p>}
                                </td>
                                <td className="px-5 py-3 align-top tabular-nums text-white">{priceLabel(t.price)}</td>
                                <td className="min-w-[120px] px-5 py-3 align-top">
                                    <span className="tabular-nums text-white">{t.sold.toLocaleString('en-IN')}</span>
                                    <span className="tabular-nums text-gray-500"> / {t.quantity.toLocaleString('en-IN')}</span>
                                    <SoldBar sold={t.sold} quantity={t.quantity} />
                                </td>
                                <td className="px-5 py-3 align-top tabular-nums">
                                    {left === 0 ? <span className="text-amber-300">Sold out</span> : <span className="text-gray-300">{left.toLocaleString('en-IN')}</span>}
                                </td>
                                <td className="px-5 py-3 text-right align-top tabular-nums text-white">{formatInr(t.sold * t.price)}</td>
                            </tr>
                        );
                    })}
                </tbody>
                {tiers.length > 1 && (
                    <tfoot className="border-t border-line-strong">
                        <tr>
                            <th scope="row" className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-400">All {totals.count} categories</th>
                            <td className="px-5 py-3" />
                            <td className="px-5 py-3 tabular-nums text-white">
                                {totals.sold.toLocaleString('en-IN')}<span className="text-gray-500"> / {totals.quantity.toLocaleString('en-IN')}</span>
                            </td>
                            <td className="px-5 py-3 tabular-nums text-gray-300">{Math.max(0, totals.quantity - totals.sold).toLocaleString('en-IN')}</td>
                            <td className="px-5 py-3 text-right tabular-nums font-semibold text-white">{formatInr(totals.grossSold)}</td>
                        </tr>
                    </tfoot>
                )}
            </table>
        </div>
    );
}
