import { useCallback, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Percent, Pencil } from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { getAdminRoleFromToken } from '../lib/adminRole';
import { useRemote } from '../lib/useRemote';
import { formatRate, previewCommission } from '../lib/settlementView';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';
import { Skeleton } from './ui/States';
import { useToast } from './ui/toastContext';

/**
 * FIRA's commission: the share of an organiser's or venue owner's earnings that
 * FIRA keeps when it pays them. Not the platform fee buyers pay.
 *
 * Two places set it:
 *  - ListingCommission, in the settlement panel of one event or venue;
 *  - OwnerCommissionCard, on a person's page - their rate for everything they list.
 *
 * Admin-only: owners and the website never see it.
 */

const pathFor = (kind, id) => `/${kind === 'venue' ? 'venues' : 'events'}/${id}`;

/**
 * The shared "type a percentage" form. `onSave(number | null)` resolves when
 * saved or throws with the message to show. `preview(rate)` returns the line
 * shown under the box while typing.
 */
function RateForm({ initial, onSave, onCancel, preview, resetLabel, saveLabel = 'Save' }) {
    const inputId = useId();
    const [text, setText] = useState(initial > 0 ? formatRate(initial) : '');
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState('');

    const typed = text.trim() === '' ? 0 : Number(text);
    const valid = Number.isFinite(typed) && typed >= 0 && typed <= 100;

    const save = async (value, which) => {
        setBusy(which);
        setError('');
        try {
            await onSave(value);
        } catch (err) {
            setError(err?.message || 'Could not save the commission');
            setBusy(null);
        }
    };

    const submit = (e) => {
        e.preventDefault();
        if (!valid) {
            setError('Enter a number from 0 to 100.');
            return;
        }
        save(typed, 'save');
    };

    return (
        <form onSubmit={submit} className="space-y-3">
            <div>
                <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-gray-300">Commission rate</label>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative w-32">
                        <input
                            id={inputId}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            max="100"
                            step="0.01"
                            autoFocus
                            placeholder="0"
                            value={text}
                            onChange={(e) => { setText(e.target.value); setError(''); }}
                            aria-invalid={Boolean(error)}
                            className="h-10 w-full rounded-xl border border-line bg-surface pl-3.5 pr-9 text-sm tabular-nums text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                        />
                        <Percent className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
                    </div>
                    <Button type="submit" size="sm" variant="violet" isLoading={busy === 'save'} disabled={Boolean(busy)}>{saveLabel}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={Boolean(busy)}>Cancel</Button>
                    {resetLabel && (
                        <Button type="button" size="sm" variant="secondary" onClick={() => save(null, 'reset')} isLoading={busy === 'reset'} disabled={Boolean(busy)}>
                            {resetLabel}
                        </Button>
                    )}
                </div>
            </div>
            {preview && valid && <p className="text-sm text-gray-300">{preview(typed)}</p>}
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        </form>
    );
}

/**
 * One listing's commission, in its settlement panel: the rate, where it came
 * from, and an editor with a live "deducts / to pay" preview. `settlement` is
 * the panel's data; `onChanged(newSettlement)` hands back the server's updated
 * figures.
 */
export function ListingCommission({ kind, listingId, settlement, onChanged }) {
    const toast = useToast();
    const [editing, setEditing] = useState(false);
    const money = settlement?.money || {};
    const commission = settlement?.commission || {};
    const rate = commission.percentage ?? money.commissionPercentage ?? 0;
    const owner = commission.owner;
    const ownerRate = owner?.percentage ?? 0;
    const who = kind === 'venue' ? 'venue owner' : 'organizer';
    const canEdit = getAdminRoleFromToken() !== 'moderator';

    const save = async (value) => {
        const updated = await adminApi.setListingCommission(kind, listingId, value);
        setEditing(false);
        const next = updated?.commission?.percentage ?? 0;
        toast.success(value === null
            ? `Back on ${owner?.name || `the ${who}`}'s rate (${formatRate(next)}%)`
            : `Commission set to ${formatRate(next)}% for this ${kind}`);
        onChanged?.(updated);
    };

    const source = commission.custom
        ? `Set for this ${kind} only`
        : rate > 0
            ? `From ${owner?.name || `the ${who}`}'s rate`
            : `No commission set for this ${who}`;

    return (
        <section className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5" aria-label="FIRA commission">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-white">FIRA commission</h3>
                    <p className="mt-0.5 text-xs text-gray-400">
                        Taken from the {who}&apos;s payout. Separate from the platform fee buyers pay.
                    </p>
                </div>
                {!editing && (
                    <div className="flex items-center gap-3">
                        <div className="text-right">
                            <p className="text-xl font-semibold tabular-nums text-white">{formatRate(rate)}%</p>
                            <p className="text-xs text-gray-400">{source}</p>
                        </div>
                        {canEdit && (
                            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} leftIcon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}>
                                Edit
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {!editing && rate > 0 && (money.ownerShare ?? 0) > 0 && (
                <p className="mt-3 border-t border-line pt-3 text-sm text-gray-300">
                    Deducts <span className="font-medium tabular-nums text-white">{formatInr(money.commissionAmount)}</span> from
                    {' '}<span className="tabular-nums">{formatInr(money.ownerShare)}</span>
                    {' · '}<span className="font-medium tabular-nums text-white">{formatInr(money.netPayable)}</span> to pay
                </p>
            )}

            {editing && (
                <div className="mt-4 border-t border-line pt-4">
                    <RateForm
                        key={`${listingId}-${rate}`}
                        initial={rate}
                        onSave={save}
                        onCancel={() => setEditing(false)}
                        // Offered only when this listing has its own rate to go back from.
                        resetLabel={commission.custom ? `Use ${owner?.name ? `${owner.name}'s` : `the ${who}'s`} rate (${formatRate(ownerRate)}%)` : null}
                        preview={(typed) => {
                            const p = previewCommission(money.ownerShare ?? 0, typed);
                            return (money.ownerShare ?? 0) > 0
                                ? `Deducts ${formatInr(p.amount)} from ${formatInr(money.ownerShare)} · ${formatInr(p.netPayable)} to pay`
                                : 'No paid sales yet. The rate will apply as sales come in.';
                        }}
                    />
                    <p className="mt-3 text-xs text-gray-500">
                        Applies to this {kind} only, and stays even if the {who}&apos;s own rate is changed later.
                    </p>
                </div>
            )}
        </section>
    );
}

const KEPT_REASON = { custom: 'has its own rate', paid: 'already has a payout recorded' };

/**
 * A person's commission rate, for their page. Setting it also updates their
 * existing events and venues - except ones with their own rate and ones already
 * paid something, which are listed so they can be changed one by one.
 */
export function OwnerCommissionCard({ userId, name, className = '' }) {
    const toast = useToast();
    const load = useCallback(() => adminApi.getOwnerCommission(userId), [userId]);
    const { data, loading, error, reload } = useRemote(load);
    const [editing, setEditing] = useState(false);
    const [lastChange, setLastChange] = useState(null);
    // The listings are folded away: pages like the creator's already list their events.
    const [showListings, setShowListings] = useState(false);

    // Moderators cannot read or set this; the server refuses them.
    if (getAdminRoleFromToken() === 'moderator') return null;

    // The rate just saved shows at once; the reload that follows confirms it.
    const rate = lastChange && lastChange.percentage !== undefined && lastChange.forUser === userId ? lastChange.percentage : data?.percentage;
    const listings = data?.listings || [];
    const person = name || 'this person';

    const save = async (value) => {
        const result = await adminApi.setOwnerCommission(userId, value);
        setEditing(false);
        setLastChange({ ...result, forUser: userId });
        toast.success(value === null || value === 0
            ? `Commission removed for ${person}`
            : `Commission set to ${formatRate(value)}% for ${person}`);
        reload();
    };

    return (
        <Card
            className={className}
            title="FIRA commission"
            description={`Taken from what FIRA pays ${person} for their events and venues.`}
            actions={!editing && !loading && !error ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)} leftIcon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}>
                    {rate > 0 ? 'Edit' : 'Set rate'}
                </Button>
            ) : null}
        >
            {loading ? (
                <Skeleton className="h-10 w-40" />
            ) : error ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-red-400">{error}</span>
                    <Button size="sm" variant="ghost" onClick={reload}>Try again</Button>
                </div>
            ) : editing ? (
                <>
                    <RateForm
                        key={`${userId}-${rate}`}
                        initial={rate || 0}
                        onSave={save}
                        onCancel={() => setEditing(false)}
                        preview={(typed) => `On an owner's share of ${formatInr(20000)}, ${formatRate(typed)}% deducts ${formatInr(previewCommission(20000, typed).amount)} and leaves ${formatInr(previewCommission(20000, typed).netPayable)} to pay.`}
                    />
                    <p className="mt-3 text-xs text-gray-500">
                        New events and venues start at this rate. Existing ones are updated too, except those with their own rate or a payout already recorded.
                    </p>
                </>
            ) : (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-2xl font-semibold tabular-nums text-white">{rate > 0 ? `${formatRate(rate)}%` : '0%'}</span>
                        <span className="text-sm text-gray-400">{rate > 0 ? 'of their share on each event and venue' : 'No commission set'}</span>
                    </div>

                    {lastChange && (
                        <div role="status" className="rounded-xl border border-line bg-surface-raised p-3.5 text-sm text-gray-300">
                            <p>
                                Applied to {lastChange.applied.length} existing {lastChange.applied.length === 1 ? 'listing' : 'listings'}.
                                {lastChange.kept.length > 0 && ` ${lastChange.kept.length} kept ${lastChange.kept.length === 1 ? 'its' : 'their'} rate:`}
                            </p>
                            {lastChange.kept.length > 0 && (
                                <ul className="mt-2 space-y-1">
                                    {lastChange.kept.map((k) => (
                                        <li key={`${k.kind}-${k.id}`}>
                                            <Link to={`${pathFor(k.kind, k.id)}#settlement`} className="text-violet-300 hover:text-violet-200">{k.name || 'Untitled'}</Link>
                                            <span className="text-gray-400"> · {formatRate(k.percentage)}% · {KEPT_REASON[k.reason] || k.reason}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {listings.length > 0 && (
                        <div>
                            <Button size="sm" variant="ghost" onClick={() => setShowListings((v) => !v)} aria-expanded={showListings}>
                                {showListings ? 'Hide their listings' : `Show their listings (${listings.length})`}
                            </Button>
                            {showListings && (
                            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                                {listings.map((l) => (
                                    <li key={`${l.kind}-${l.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-sm">
                                        <Link to={`${pathFor(l.kind, l.id)}#settlement`} className="min-w-0 truncate text-gray-200 hover:text-violet-300">
                                            {l.name || 'Untitled'}
                                        </Link>
                                        <span className="flex items-center gap-1.5">
                                            <StatusBadge tone={l.kind === 'venue' ? 'info' : 'accent'}>{l.kind === 'venue' ? 'Venue' : 'Event'}</StatusBadge>
                                            {l.custom && <StatusBadge tone="warning">Own rate</StatusBadge>}
                                            {l.paid && <StatusBadge tone="neutral">Payout recorded</StatusBadge>}
                                            <span className="w-12 text-right font-medium tabular-nums text-white">{formatRate(l.percentage)}%</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            )}
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
