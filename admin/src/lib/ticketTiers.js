/**
 * An event's ticket categories (tiers), in one shape the admin can show.
 *
 * Events with tiers carry `ticketTiers: [{ name, price, maxQuantity, soldCount }]`.
 * `event.ticketPrice` is NOT a summary of them: the create form sets it to the
 * FIRST tier's price, so any screen that shows ticketPrice shows one category of
 * three. Older events have no tiers - they are shown as one "General" category
 * built from ticketPrice / maxAttendees / currentAttendees.
 */
export function eventTiers(event) {
    const tiers = Array.isArray(event?.ticketTiers) ? event.ticketTiers : [];
    if (tiers.length > 0) {
        return tiers.map((t, i) => ({
            key: t._id || `${t.name}-${i}`,
            name: t.name || `Category ${i + 1}`,
            description: t.description || '',
            price: Number(t.price) || 0,
            quantity: Number(t.maxQuantity) || 0,
            sold: Number(t.soldCount) || 0,
        }));
    }
    return [{
        key: 'general',
        name: 'General',
        description: '',
        price: Number(event?.ticketPrice) || 0,
        quantity: Number(event?.maxAttendees) || 0,
        sold: Number(event?.currentAttendees) || 0,
    }];
}

/** Totals across every category, plus the price range ("₹499 – ₹1,999"). */
export function tierTotals(tiers) {
    const prices = tiers.map((t) => t.price);
    return {
        count: tiers.length,
        sold: tiers.reduce((s, t) => s + t.sold, 0),
        quantity: tiers.reduce((s, t) => s + t.quantity, 0),
        // Face value of what has sold, category by category (before discounts).
        grossSold: tiers.reduce((s, t) => s + t.sold * t.price, 0),
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
    };
}
