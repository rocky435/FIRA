import { useCallback, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
    CalendarDays, IndianRupee, Users as UsersIcon, Eye, Check, X, Ban, RotateCcw, Trash2, BadgeCheck, ExternalLink, ChevronRight,
} from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { useRemote } from '../lib/useRemote';
import { humanize } from '../lib/statusStyles';
import { brandActions, brandAvailable, useConfirmedAction } from '../lib/listingActions';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import AfterRazorpay from '../components/AfterRazorpay';
import { StatusBadge } from '../components/ui/StatusBadge';
import { InfoList } from '../components/ui/InfoList';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState, PageSkeleton } from '../components/ui/States';
import { OwnerCommissionCard } from '../components/Commission';

const formatDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Creators save either a full URL or just a handle. The old page linked
// Instagram to "#", so the link went nowhere.
const SOCIAL = [
    { key: 'instagram', label: 'Instagram', base: 'https://instagram.com/' },
    { key: 'twitter', label: 'X / Twitter', base: 'https://x.com/' },
    { key: 'facebook', label: 'Facebook', base: 'https://facebook.com/' },
    { key: 'youtube', label: 'YouTube', base: 'https://youtube.com/@' },
    { key: 'spotify', label: 'Spotify', base: null },
    { key: 'website', label: 'Website', base: null },
];
function socialHref(value, base) {
    const v = String(value).trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (!base) return `https://${v.replace(/^\/+/, '')}`;
    return base + v.replace(/^@/, '');
}

// The page carries the creator's whole event history; the first few show by default.
const EVENTS_PREVIEW = 10;

export default function BrandDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const runAction = useConfirmedAction();
    const loadBrand = useCallback(() => adminApi.getBrandById(id), [id]);
    const { data: brand, loading, refreshing, error, reload } = useRemote(loadBrand);
    const [showAllEvents, setShowAllEvents] = useState(false);

    if (loading && !error) return <PageSkeleton />;
    if (brand && brand._id !== id && !error) return <PageSkeleton />;
    if (error || !brand) {
        return (
            <div className="p-4 sm:p-6 lg:p-8">
                <PageHeader title="Creator" backTo="/brands" backLabel="Back to creators" />
                <Card>
                    <ErrorState title={error ? "Couldn't load this creator" : 'Creator not found'} message={error || 'It may have been deleted.'} onRetry={error ? reload : undefined} />
                </Card>
            </div>
        );
    }

    const stats = brand.stats || {};
    const events = brand.events || [];
    const owner = brand.user || {};
    const badge = owner.verificationBadge && owner.verificationBadge !== 'none' ? owner.verificationBadge : null;
    const actions = brandActions(brand);
    const available = brandAvailable(brand);
    const act = async (key) => {
        if (await runAction(actions[key])) {
            if (key === 'remove') navigate('/brands');
            else reload();
        }
    };
    const socials = SOCIAL.filter((s) => brand.socialLinks?.[s.key]);
    const cities = [...new Set([brand.primaryCity, ...(brand.cities || [])].filter(Boolean))];

    return (
        <div className={`p-4 sm:p-6 lg:p-8 transition-opacity ${refreshing ? 'opacity-70' : ''}`}>
            {brand.coverPhoto && (
                <div className="mb-6 overflow-hidden rounded-2xl border border-line">
                    <img src={brand.coverPhoto} alt={`${brand.name} cover`} loading="lazy" className="h-40 w-full object-cover sm:h-52" />
                </div>
            )}
            <PageHeader
                title={(
                    <span className="flex items-center gap-3">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white/[0.06] text-lg font-semibold text-white">
                            {brand.profilePhoto
                                ? <img src={brand.profilePhoto} alt="" className="h-full w-full object-cover" />
                                : (brand.name?.charAt(0) || 'C').toUpperCase()}
                        </span>
                        <span className="min-w-0">{brand.name}</span>
                    </span>
                )}
                backTo="/brands"
                backLabel="Back to creators"
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
                    <StatusBadge value={brand.status || 'pending'} />
                    {brand.type && <StatusBadge tone="neutral">{humanize(brand.type)}</StatusBadge>}
                    {owner.isVerified && <StatusBadge tone="accent" icon={BadgeCheck}>{badge ? `Verified ${humanize(badge)}` : 'Verified'}</StatusBadge>}
                    {brand.isActive === false && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                </div>
            </PageHeader>

            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                {/* Full history from the server: hosted = live or completed, the hint counts everything. */}
                <StatCard
                    label="Events hosted"
                    value={(stats.eventsHosted ?? events.length).toLocaleString('en-IN')}
                    icon={CalendarDays}
                    accent="blue"
                    hint={`${(stats.totalEvents ?? events.length).toLocaleString('en-IN')} created in total`}
                />
                <StatCard
                    label="Ticket sales"
                    value={formatInr(stats.totalRevenue || 0)}
                    icon={IndianRupee}
                    accent="green"
                    hint={(
                        <>
                            All events, full price before discounts
                            {stats.collected > 0 && <span className="mt-0.5 block">Buyers paid <span className="tabular-nums text-gray-300">{formatInr(stats.collected)}</span></span>}
                            <AfterRazorpay amount={stats.collected} after={stats.afterGateway} fee={stats.gatewayFee} percent={stats.gatewayFeePercent} />
                        </>
                    )}
                />
                <StatCard label="Followers" value={(stats.followers || 0).toLocaleString('en-IN')} icon={UsersIcon} accent="violet" />
                <StatCard label="Profile views" value={(stats.views || 0).toLocaleString('en-IN')} icon={Eye} accent="amber" />
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    <Card title="About">
                        <InfoList
                            items={[
                                { label: 'Bio', value: brand.bio, wide: true },
                                { label: 'Type', value: brand.type ? humanize(brand.type) : null },
                                { label: 'Cities', value: cities.length ? cities.join(', ') : null },
                                { label: 'Address', value: brand.address, wide: true },
                                { label: 'Applied', value: formatDate(brand.createdAt) },
                                {
                                    label: 'Links',
                                    wide: true,
                                    value: socials.length ? (
                                        <span className="flex flex-wrap gap-x-4 gap-y-1">
                                            {socials.map((s) => (
                                                <a key={s.key} href={socialHref(brand.socialLinks[s.key], s.base)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200">
                                                    {s.label} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                                </a>
                                            ))}
                                        </span>
                                    ) : null,
                                },
                            ]}
                        />
                        {!brand.bio && socials.length === 0 && cities.length === 0 && (
                            <p className="text-sm text-gray-400">This creator hasn't added any profile details yet.</p>
                        )}
                    </Card>

                    <Card
                        title="Events"
                        description={events.length ? `All ${events.length.toLocaleString('en-IN')}, newest first - including cancelled and removed` : undefined}
                        padded={false}
                    >
                        {events.length === 0 ? (
                            <div className="border-t border-line"><EmptyState icon={CalendarDays} title="No events yet" /></div>
                        ) : (
                            <>
                            <ul className="divide-y divide-line border-t border-line">
                                {(showAllEvents ? events : events.slice(0, EVENTS_PREVIEW)).map((event) => (
                                    <li key={event._id}>
                                        <Link to={`/events/${event._id}`} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-hover">
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate font-medium text-white group-hover:text-violet-300">{event.name}</p>
                                                <p className="text-xs text-gray-400">
                                                    {/* Custom-venue events carry the name on customVenue. */}
                                                    {event.venue?.name || event.customVenue?.name || 'Custom venue'}
                                                    {' · '}
                                                    {formatDate(event.startDateTime) || 'Date TBD'}
                                                </p>
                                            </div>
                                            <span className="hidden text-sm tabular-nums text-gray-300 sm:block">
                                                <span className="text-white">{(event.currentAttendees || 0).toLocaleString('en-IN')}</span> / {(event.maxAttendees || 0).toLocaleString('en-IN')} tickets
                                            </span>
                                            {event.isDeleted && event.status !== 'cancelled' && <StatusBadge tone="neutral">Removed</StatusBadge>}
                                            <StatusBadge value={event.status} />
                                            <ChevronRight className="h-4 w-4 text-gray-500 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                            {events.length > EVENTS_PREVIEW && (
                                <div className="border-t border-line px-5 py-3">
                                    <Button variant="ghost" size="sm" onClick={() => setShowAllEvents((v) => !v)}>
                                        {showAllEvents ? 'Show fewer' : `Show all ${events.length.toLocaleString('en-IN')} events`}
                                    </Button>
                                </div>
                            )}
                            </>
                        )}
                    </Card>
                </div>

                <div className="space-y-6">
                    <Card title="Owner">
                        <InfoList
                            className="sm:grid-cols-1"
                            items={[
                                { label: 'Name', value: owner._id ? <Link to={`/users/${owner._id}`} className="hover:text-violet-300">{owner.name || 'Unnamed'}</Link> : (owner.name || '—') },
                                { label: 'Email', value: owner.email || '—' },
                                { label: 'Phone', value: owner.phone || '—' },
                                {
                                    label: 'Verified badge',
                                    value: owner.isVerified
                                        ? <StatusBadge tone="accent" icon={BadgeCheck}>{badge ? humanize(badge) : 'Verified'}</StatusBadge>
                                        : <span className="text-gray-400">Not verified</span>,
                                },
                            ]}
                        />
                    </Card>

                    {/* The commission is the owner account's: it covers every event they organise. */}
                    {owner._id && <OwnerCommissionCard userId={owner._id} name={owner.name} />}

                    {brand.members?.length > 0 && (
                        <Card title="Members" description={`${brand.members.length} ${brand.members.length === 1 ? 'person' : 'people'}`}>
                            <ul className="space-y-3">
                                {brand.members.map((m, i) => (
                                    <li key={m._id || `${m.name}-${i}`} className="flex items-center gap-3">
                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/[0.06] text-xs font-medium text-white">
                                            {m.photoUrl ? <img src={m.photoUrl} alt="" className="h-full w-full object-cover" /> : (m.name?.charAt(0) || '?').toUpperCase()}
                                        </span>
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm text-white">{m.name}</span>
                                            <span className="block truncate text-xs text-gray-400">{m.role}</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
