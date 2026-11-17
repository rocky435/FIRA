import { useEffect, useState } from 'react';
import adminApi from '../api/adminApi';

// The Razorpay fee rate the admin panel estimates deductions with. It is set on
// the server (RAZORPAY_FEE_PERCENT, default 2.36 = 2% + 18% GST) and fetched
// once per page load, then shared by every figure that shows it.
let cached = null;
let pending = null;

function load() {
    if (!pending) {
        pending = adminApi.getGatewayFee()
            .then((r) => { cached = Number(r?.percent); return cached; })
            .catch(() => { pending = null; return null; });
    }
    return pending;
}

/** The rate in percent, or null until it has loaded (callers hide the line until then). */
export function useGatewayFeePercent() {
    const [percent, setPercent] = useState(cached);
    useEffect(() => {
        if (cached != null) return undefined;
        let live = true;
        load().then((p) => { if (live && p != null) setPercent(p); });
        return () => { live = false; };
    }, []);
    return percent;
}

/** { fee, after } for an amount at `percent`, rounded to paise like the server. */
export function gatewaySplit(amount, percent) {
    const fee = Math.round(((amount || 0) * (percent || 0)) / 100 * 100) / 100;
    return { fee, after: Math.round(((amount || 0) - fee) * 100) / 100 };
}
