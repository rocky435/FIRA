/** The smallest "round" number (1, 2, 2.5, 5 x 10^n) at or above `n`; 4 when n is 0. Chart axis tops. */
export function niceCeiling(n) {
    if (!(n > 0)) return 4;
    const exp = 10 ** Math.floor(Math.log10(n));
    for (const step of [1, 2, 2.5, 5, 10]) {
        if (step * exp >= n) return step * exp;
    }
    return 10 * exp;
}

/** Like niceCeiling, but divisible by 4 so every quarter tick is a whole number (counts). */
export function wholeCeiling(n) {
    // Small counts: the next multiple of 4 (3 -> 4, 10 -> 12).
    if (!(n > 20)) return Math.max(4, Math.ceil(Math.max(n || 0, 1) / 4) * 4);
    // Larger: the next round number that splits into whole quarters (250 -> 400).
    for (const top of [40, 80, 100, 200, 400, 800, 1000]) if (top >= n) return top;
    let top = niceCeiling(n);
    while (top % 4 !== 0) top = niceCeiling(top + 1);
    return top;
}
