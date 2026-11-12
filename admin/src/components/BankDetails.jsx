import { Landmark } from 'lucide-react';

/**
 * Payout bank details for a venue owner or event organizer.
 *
 * Admin-only read (Flow 8.6): the whole panel sits behind the admin session and
 * the server only sends bankDetails on admin routes. Used on Venue Owners, the
 * venue page (owner) and the event page (organizer) - the event page received
 * the organizer's details all along but never showed them.
 */
export default function BankDetails({ bank }) {
    const hasAny = bank && (bank.accountNumber || bank.ifscCode || bank.accountName || bank.bankName);
    return (
        <div className="rounded-xl border border-line bg-surface-raised p-3.5">
            <div className="mb-2 flex items-center gap-2">
                <Landmark className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                <span className="text-xs font-semibold uppercase tracking-wide text-amber-300">Bank details</span>
                <span className="text-[10px] text-gray-500">(admin-only)</span>
            </div>
            {!hasAny ? (
                <p className="text-sm text-gray-500">No bank details on file.</p>
            ) : (
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {[
                        ['Account Name', bank.accountName],
                        ['Account Number', bank.accountNumber],
                        ['IFSC Code', bank.ifscCode],
                        ['Bank Name', bank.bankName],
                    ].map(([label, value]) => (
                        <div key={label}>
                            <dt className="text-[11px] text-gray-500">{label}</dt>
                            <dd className="break-all text-sm text-gray-200">{value || '—'}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}
