import { formatInr } from '../lib/formatInr';

/**
 * One small line under a money figure: what is left of it after Razorpay's
 * estimated fee. Admin only. Shows nothing until the rate is known, or when
 * there is nothing to take a fee from.
 *
 *   <AfterRazorpay amount={collected} after={afterGateway} fee={gatewayFee} percent={2.36} />
 */
export default function AfterRazorpay({ amount, after, fee, percent, prefix }) {
    if (percent == null || !(amount > 0)) return null;
    return (
        <span className="mt-0.5 block" title={`Razorpay fee ${percent}% (estimated): −${formatInr(fee || 0)}`}>
            {prefix}After Razorpay <span className="tabular-nums text-gray-300">{formatInr(after || 0)}</span>
            <span className="text-gray-600"> · −{percent}%</span>
        </span>
    );
}
