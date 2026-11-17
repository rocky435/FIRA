import { useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
    CalendarDays, IndianRupee, Star, MapPin, ExternalLink, Check, X, Ban, RotateCcw,
    Trash2, IdCard, TriangleAlert, Image as ImageIcon,
} from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { useRemote } from '../lib/useRemote';
import { humanize } from '../lib/statusStyles';
import { venueActions, venueAvailable, useConfirmedAction } from '../lib/listingActions';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import AfterRazorpay from '../components/AfterRazorpay';
import { StatusBadge } from '../components/ui/StatusBadge';
import { InfoList } from '../components/ui/InfoList';
import { Button } from '../components/ui/Button';
import { ErrorState, PageSkeleton } from '../components/ui/States';
import BankDetails from '../components/BankDetails';
import ListingSettlementPanel from '../components/ListingSettlementPanel';

const formatDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const capacityText = (capacity) => {
    if (capacity == null) return null;
    if (typeof capacity !== 'object') return Number(capacity).toLocaleString('en-IN');
    const { min, max } = capacity;
    if (min != null && max != null) return `${Number(min).toLocaleString('en-IN')} – ${Number(max).toLocaleString('en-IN')} guests`;
    return `${Number(max ?? min ?? 0).toLocaleString('en-IN')} guests`;
};

// The venue's price is a day rate. The old "Per Hour" card read a top-level
// `pricePerHour` that venues never had, so it showed ₹0 for every venue.
// pricePerDay is authoritative; basePrice is its back-compat mirror on older venues.
const dayRate = (venue) => venue.pricing?.pricePerDay ?? venue.pricing?.basePrice ?? null;

const ID_TEXT = { verified: 'ID verified', pending: 'ID waiting for review', rejected: 'ID rejected' };
const ID_TONE = { verified: 'success', pending: 'warning', rejected: 'danger' };

export default function VenueDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const runAction = useConfirmedAction();
    const loadVenue = useCallback(() => adminApi.getVenueById(id), [id]);
    const { data: venue, loading, refreshing, error, reload } = useRemote(loadVenue);

    if (loading && !error) return <PageSkeleton />;
    // Moved from one venue to another: the previous one is still held while the
    // next loads.
    if (venue && venue._id !== id && !error) return <PageSkeleton />;
    if (error || !venue) {
        return (
            <div className="p-4 sm:p-6 lg:p-8">
                <PageHeader title="Venue" backTo="/venues" backLabel="Back to venues" />
                <Card>
                    <ErrorState title={error ? "Couldn't load this venue" : 'Venue not found'} message={error || 'It may have been deleted.'} onRetry={error ? reload : undefined} />
                </Card>
            </div>
        );
    }

    const stats = venue.stats || {};
    const actions = venueActions(venue);
    const available = venueAvailable(venue);
    const act = async (key) => {
        if (await runAction(actions[key])) {
            if (key === 'remove') navigate('/venues');
            else reload();
        }
    };
    const owner = venue.owner || {};
    const rate = dayRate(venue);
    const weekend = venue.pricing?.weekendPricePerDay;
    const policy = venue.cancellationPolicy;
    const address = [venue.address?.street, venue.address?.city, venue.address?.state, venue.address?.pincode].filter(Boolean).join(', ');
    const images = (venue.images || []).filter(Boolean);

    return (
        <div className={`p-4 sm:p-6 lg:p-8 transition-opacity ${refreshing ? 'opacity-70' : ''}`}>
            <PageHeader
                title={venue.name}
                backTo="/venues"
                backLabel="Back to venues"
                actions={(
                    <>
                        {available.approve && <Button variant="success" onClick={() => act('approve')} leftIcon={<Check className="h-4 w-4" aria-hidden="true" />}>Approve</Button>}
                        {available.reject && <Button variant="secondary" onClick={() => act('reject')} leftIcon={<X className="h-4 w-4" aria-hidden="true" />}>Reject</Button>}
                        {available.block && <Button variant="secondary" onClick={() => act('block')} leftIcon={<Ban className="h-4 w-4" aria-hidden="true" />}>Block</Button>}
                        {available.unblock && <Button variant="secondary" onClick={() => act('unblock')} leftIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}>Unblock</Button>}
                        <Button variant="danger" onClick={() => act('remove')} leftIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}>Delete</Button>
                    </>
                )}
            >
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={venue.status} />
                    {venue.venueType && <StatusBadge tone="neutral">{humanize(venue.venueType)}</StatusBadge>}
                    {address && (
                        <span className="ml-1 inline-flex items-center gap-1 text-sm text-gray-400">
                            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />{address}
                        </span>
                    )}
                </div>
            </PageHeader>

            {venue.deletionRequest?.requestedAt && (
                <div role="note" className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                    <div>
                        <p className="font-medium text-red-200">The owner asked for this venue to be removed{formatDate(venue.deletionRequest.requestedAt) ? ` on ${formatDate(venue.deletionRequest.requestedAt)}` : ''}.</p>
                        {venue.deletionRequest.reason && <p className="mt-1 text-red-100/80">Reason: {venue.deletionRequest.reason}</p>}
                        <p className="mt-1 text-gray-400">Deleting cancels its upcoming bookings and adds what guests paid to Refunds.</p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                <StatCard label="Bookings" value={(stats.totalBookings || 0).toLocaleString('en-IN')} icon={CalendarDays} accent="blue" to={`/bookings?venue=${venue._id}`} hint={`${stats.completedBookings || 0} completed`} />
                <StatCard
                    label="Received from guests"
                    value={formatInr(stats.totalRevenue || 0)}
                    icon={IndianRupee}
                    accent="green"
                    hint={<>Paid bookings<AfterRazorpay amount={stats.totalRevenue} after={stats.afterGateway} fee={stats.gatewayFee} percent={stats.gatewayFeePercent} /></>}
                />
                <StatCard label="Day rate" value={rate != null ? formatInr(rate) : '—'} icon={IndianRupee} accent="violet" hint={weekend ? `Weekend ${formatInr(weekend)}` : 'Same every day'} />
                <StatCard
                    label="Rating"
                    value={venue.rating?.count ? venue.rating.average.toFixed(1) : '—'}
                    icon={Star}
                    accent="amber"
                    hint={venue.rating?.count ? `${venue.rating.count} ${venue.rating.count === 1 ? 'review' : 'reviews'}` : 'No reviews yet'}
                />
            </div>

            {images.length > 0 && (
                <div className="mt-6 -mx-1 flex gap-3 overflow-x-auto px-1 pb-1" aria-label="Venue photos">
                    {images.map((src, i) => (
                        <a key={src} href={src} target="_blank" rel="noreferrer" className="block shrink-0 overflow-hidden rounded-xl border border-line">
                            <img src={src} alt={`${venue.name} photo ${i + 1}`} loading="lazy" className="h-32 w-48 object-cover sm:h-40 sm:w-60" />
                        </a>
                    ))}
                </div>
            )}

            <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    <Card title="Venue details">
                        <InfoList
                            items={[
                                { label: 'Description', value: venue.description, wide: true },
                                { label: 'Capacity', value: capacityText(venue.capacity) },
                                { label: 'Venue type', value: venue.venueType ? humanize(venue.venueType) : null },
                                { label: 'Address', value: address || null, wide: true },
                                {
                                    label: 'Map',
                                    value: venue.locationLink ? (
                                        <a href={venue.locationLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200">
                                            Open in maps <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                        </a>
                                    ) : null,
                                },
                                { label: 'Booking requests', value: venue.autoApproveBookings ? 'Accepted automatically' : 'Owner accepts each one' },
                                { label: 'Platform fee', value: venue.platformFeePercentage != null ? `${venue.platformFeePercentage}%` : null },
                                { label: 'Listed', value: formatDate(venue.createdAt) },
                                {
                                    label: 'Cancellation policy',
                                    wide: true,
                                    value: policy ? `Free cancellation up to ${policy.freeCancellationHours}h before · ${policy.partialRefundPercentage}% refund after that · no refund in the last ${policy.noCancellationHours}h` : null,
                                },
                                {
                                    label: 'Special date prices',
                                    wide: true,
                                    value: venue.pricing?.specialDates?.length
                                        ? venue.pricing.specialDates.map((s) => `${s.date}: ${formatInr(s.pricePerDay)}`).join(' · ')
                                        : null,
                                },
                            ]}
                        />
                    </Card>

                    {(venue.amenities?.length > 0 || venue.rules?.length > 0) && (
                        <Card title="Amenities and rules">
                            {venue.amenities?.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {venue.amenities.map((a) => <StatusBadge key={a} tone="accent">{a}</StatusBadge>)}
                                </div>
                            )}
                            {venue.rules?.length > 0 && (
                                <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-gray-300">
                                    {venue.rules.map((r) => <li key={r}>{r}</li>)}
                                </ul>
                            )}
                        </Card>
                    )}
                </div>

                <div className="space-y-6">
                    <Card
                        title="Owner"
                        actions={owner._id ? (
                            <StatusBadge tone={ID_TONE[owner.govIdStatus] || 'neutral'} icon={IdCard}>{ID_TEXT[owner.govIdStatus] || 'ID not submitted'}</StatusBadge>
                        ) : null}
                    >
                        <InfoList
                            className="sm:grid-cols-1"
                            items={[
                                { label: 'Name', value: owner._id ? <Link to={`/users/${owner._id}`} className="hover:text-violet-300">{owner.name || 'Unnamed'}</Link> : (owner.name || '—') },
                                { label: 'Email', value: owner.email || '—' },
                                { label: 'Phone', value: owner.phone || '—' },
                            ]}
                        />
                        {owner.govIdStatus !== 'verified' && venue.status === 'pending' && (
                            <p className="mt-4 text-xs text-amber-200/80">
                                This venue can't be approved until the owner's government ID is verified.{' '}
                                <Link to="/venue-owners" className="text-violet-300 hover:text-violet-200">Review it in Venue Owners</Link>
                            </p>
                        )}
                        <div className="mt-4">
                            <BankDetails bank={owner.bankDetails} />
                        </div>
                    </Card>

                    {images.length === 0 && (
                        <Card>
                            <p className="flex items-center gap-2 text-sm text-gray-400"><ImageIcon className="h-4 w-4" aria-hidden="true" />No photos uploaded.</p>
                        </Card>
                    )}
                </div>
            </div>

            {/* Settlement ledger for this venue — renders its own titled card. */}
            <ListingSettlementPanel kind="venue" listingId={id} />
        </div>
    );
}
