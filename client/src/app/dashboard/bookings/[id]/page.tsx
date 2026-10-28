'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import DashboardLayout from '@/components/dashboard/DashboardLayout';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { bookingsApi } from '@/lib/api';
import { calculateBilling } from '@/components/BillingCard';
import { formatBookingDates } from '@/lib/dateUtils';
import { DEFAULT_PLATFORM_FEE_PERCENTAGE } from '@/lib/venuePricing';
import { FadeIn, SlideUp } from '@/components/animations';

interface Booking {
    _id: string;
    venue: {
        _id: string;
        name: string;
        images?: string[];
        address?: { city?: string; state?: string };
        platformFeePercentage?: number;
    };
    bookingDate: string;
    /** Last day of a multi-day booking; absent for a single day. */
    endDate?: string | null;
    startTime: string;
    endTime: string;
    purpose?: string;
    expectedGuests: number;
    status: string;
    paymentStatus: string;
    totalAmount: number;
    cancellationReason?: string | null;
    /** Set when this is the venue booking for the organiser's own event. */
    event?: { _id: string; name: string; status?: string } | string | null;
    // Once accepted: pay the advance or the full amount by this, or the booking is cancelled.
    paymentDueAt?: string | null;
    ownerResponse?: { respondBy?: string | null };
    paymentSchedule?: {
        type?: 'full' | 'installment';
        depositAmount?: number;
        balanceAmount?: number;
        balanceDueAt?: string | null;
        balanceStatus?: 'not_applicable' | 'pending' | 'paid' | 'forfeited';
    };
}

declare global {
    interface Window {
        Razorpay: any;
    }
}

const inr = (n: number | undefined) =>
    `₹${(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const formatDue = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

/**
 * The booking's payment schedule. Before payment it is the offer: more than 7
 * days out, a 10% advance (the rest due 24 hours before) or the full amount;
 * within 7 days, the full amount. Once paid it is what the guest chose. Amounts
 * are before the platform fee and GST, which are added at checkout.
 */
function scheduleOf(b: Booking) {
    const s = b.paymentSchedule || {};
    const installment = s.type === 'installment';
    return {
        installment,
        upfront: installment ? (s.depositAmount ?? 0) : (s.depositAmount || b.totalAmount),
        balance: installment ? (s.balanceAmount ?? 0) : 0,
        balanceDueAt: s.balanceDueAt || null,
        balanceStatus: s.balanceStatus || 'not_applicable',
    };
}

/** Where the booking stands, in the guest's words. */
function stageOf(b: Booking) {
    const s = scheduleOf(b);
    if (b.status === 'rejected') return 'Declined by the venue';
    if (b.status === 'cancelled') {
        if (b.cancellationReason === 'missed_payment_deadline') return 'Cancelled - balance not paid in time';
        if (b.cancellationReason === 'venue_did_not_respond') return 'Expired - venue did not respond in time';
        if (b.cancellationReason === 'payment_not_received') return 'Cancelled - not paid in time';
        return 'Cancelled';
    }
    if (b.status === 'completed') return 'Completed';
    if (b.status === 'pending') return b.paymentStatus === 'paid' ? 'Waiting for the venue to confirm' : 'Request sent - waiting for the venue';
    if (b.paymentStatus !== 'paid') return 'Accepted - pay to confirm';
    if (s.installment && s.balanceStatus === 'pending') return 'Confirmed - balance due';
    return 'Confirmed';
}

const stageTone = (b: Booking) => {
    if (b.status === 'rejected' || b.status === 'cancelled') return 'bg-red-500/15 text-red-300 border-red-500/30';
    if (b.status === 'pending') return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
    if (b.status === 'accepted' && b.paymentStatus !== 'paid') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
};

/**
 * The payment journey as steps. Four once an advance is paid (the balance is a
 * step of its own); three otherwise. `done` counts the completed steps.
 */
function progressOf(b: Booking) {
    const s = scheduleOf(b);
    const paid = b.paymentStatus === 'paid';
    const split = paid && s.installment;
    const steps = split
        ? ['Requested', 'Accepted', 'Advance paid', 'Fully paid']
        : ['Requested', 'Accepted', 'Paid'];
    // Steps after "Requested" only count once the venue has accepted, even if
    // an older booking was paid before that.
    let done = 1;
    if (b.status === 'accepted' || b.status === 'completed') {
        done = 2;
        if (paid) done = 3;
        if (split && s.balanceStatus === 'paid') done = 4;
    }
    if (b.status === 'completed') done = steps.length;
    return { steps, done };
}

function Progress({ booking }: { booking: Booking }) {
    const { steps, done } = progressOf(booking);
    return (
        <ol className="flex items-start" aria-label="Booking progress">
            {steps.map((label, i) => {
                const complete = i < done;
                const current = i === done;
                return (
                    <li key={label} className="flex-1 flex flex-col items-center text-center relative">
                        {i > 0 && (
                            <span
                                aria-hidden
                                className={`absolute top-3 right-1/2 w-full h-0.5 ${i < done ? 'bg-violet-500' : 'bg-white/10'}`}
                            />
                        )}
                        <span
                            className={`relative z-10 flex items-center justify-center w-6 h-6 rounded-full border-2 text-[11px] font-semibold ${complete
                                ? 'bg-violet-500 border-violet-500 text-white'
                                : current
                                    ? 'bg-black border-violet-400 text-violet-300'
                                    : 'bg-black border-white/15 text-gray-500'
                                }`}
                        >
                            {complete ? (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                            ) : i + 1}
                        </span>
                        <span className={`mt-2 text-[11px] sm:text-xs leading-tight px-1 ${complete || current ? 'text-gray-200' : 'text-gray-500'}`}>
                            {label}
                        </span>
                        <span className="sr-only">{complete ? '(done)' : current ? '(next)' : ''}</span>
                    </li>
                );
            })}
        </ol>
    );
}

/** One charge: the booking amount, the platform fee and GST on it, and the total. */
function Charge({ amount, feePct, label }: { amount: number; feePct: number; label: string }) {
    const bill = calculateBilling(amount, 1, feePct);
    return (
        <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3 text-gray-300">
                <dt>{label}</dt>
                <dd className="whitespace-nowrap">{inr(bill.subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-gray-400">
                <dt>Platform fee</dt>
                <dd className="whitespace-nowrap">{inr(bill.platformFee)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-gray-400">
                <dt>GST (18%)</dt>
                <dd className="whitespace-nowrap">{inr(bill.gstAmount)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-white font-semibold pt-2 border-t border-white/10">
                <dt>You pay</dt>
                <dd className="whitespace-nowrap">{inr(bill.totalAmount)}</dd>
            </div>
        </dl>
    );
}

function PaidRow({ label, amount }: { label: string; amount: number }) {
    return (
        <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-gray-200">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-300" aria-hidden>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                </span>
                {label}
            </span>
            <span className="text-emerald-300 whitespace-nowrap">{inr(amount)} paid</span>
        </div>
    );
}

/**
 * Dedicated page for one booking, opened from a row in My Bookings. Everything
 * that acts on a booking - paying the advance or the rest, cancelling - lives
 * here, so the Razorpay checkout script is only loaded on the one screen that
 * can actually use it.
 */
export default function BookingDetailPage() {
    const { id } = useParams<{ id: string }>();
    const router = useRouter();
    const { isAuthenticated, isLoading, user } = useAuth();
    const { showToast } = useToast();
    const [booking, setBooking] = useState<Booking | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState<null | 'advance' | 'full' | 'balance' | 'cancel'>(null);
    const [confirmingCancel, setConfirmingCancel] = useState(false);

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.push('/signin');
    }, [isLoading, isAuthenticated, router]);

    useEffect(() => {
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.async = true;
        document.body.appendChild(script);
        return () => { document.body.removeChild(script); };
    }, []);

    const fetchBooking = useCallback(async () => {
        if (!id) return;
        try {
            setLoading(true);
            const data = await bookingsApi.getById(id) as Booking | { booking: Booking };
            setBooking('booking' in data ? data.booking : data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load booking');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => { fetchBooking(); }, [fetchBooking]);

    // One checkout for every charge, all after the venue accepts: the 10%
    // advance or the full amount to confirm, then the rest of an advance.
    const handlePay = async (which: 'advance' | 'full' | 'balance') => {
        if (!user?._id || !booking) return;
        setBusy(which);
        try {
            const paymentData = which === 'balance'
                ? await bookingsApi.initiateBalancePayment(booking._id, user._id)
                : await bookingsApi.initiatePayment(booking._id, user._id, which);
            const razorpay = new window.Razorpay({
                key: paymentData.keyId,
                amount: paymentData.amount,
                currency: paymentData.currency,
                name: 'FIRA',
                description: `${which === 'balance' ? 'Remaining amount' : which === 'advance' ? 'Booking advance' : 'Booking payment'} - ${booking.venue?.name}`,
                order_id: paymentData.gatewayOrderId,
                handler: async (response: any) => {
                    const proof = {
                        gatewayOrderId: response.razorpay_order_id,
                        gatewayPaymentId: response.razorpay_payment_id,
                        gatewaySignature: response.razorpay_signature,
                    };
                    try {
                        if (which !== 'balance') {
                            await bookingsApi.verifyPayment(booking._id, proof);
                            showToast('Payment received. Your booking is confirmed.', 'success');
                        } else {
                            await bookingsApi.verifyBalancePayment(booking._id, proof);
                            showToast('Remaining amount paid. Your booking is fully paid.', 'success');
                        }
                        fetchBooking();
                    } catch {
                        showToast('Payment verification failed. Please contact support.', 'error');
                    }
                },
                prefill: { name: user.name, email: user.email },
                theme: { color: '#8b5cf6' },
                modal: { ondismiss: () => setBusy(null) },
            });
            razorpay.open();
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to initiate payment', 'error');
        } finally {
            setBusy(null);
        }
    };

    const handleCancel = async () => {
        if (!user?._id || !booking) return;
        setBusy('cancel');
        try {
            const result = await bookingsApi.cancel(booking._id, user._id);
            setConfirmingCancel(false);
            showToast(
                result.refundStatus === 'pending_approval'
                    ? `Booking cancelled. A refund of ${inr(result.refundAmount)} (${result.refundPercentage}% under the venue's policy) has been requested - the FIRA team will process it.`
                    : 'Booking cancelled.',
                'success'
            );
            fetchBooking();
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to cancel booking', 'error');
        } finally {
            setBusy(null);
        }
    };

    if (isLoading || !isAuthenticated) {
        return (
            <DashboardLayout>
                <div className="min-h-screen flex items-center justify-center">
                    <div className="animate-spin w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full" />
                </div>
            </DashboardLayout>
        );
    }

    const schedule = booking ? scheduleOf(booking) : null;
    const feePct = booking?.venue?.platformFeePercentage ?? DEFAULT_PLATFORM_FEE_PERCENTAGE;
    const paid = booking?.paymentStatus === 'paid';
    const ended = !!booking && ['rejected', 'cancelled'].includes(booking.status);
    const canPayUpfront = !!booking && booking.status === 'accepted' && !paid;
    const awaitingVenue = !!booking && booking.status === 'pending' && !paid;
    // The rest of an advance is due only once the advance itself is paid.
    const canPayBalance = !!booking && !!schedule && booking.status === 'accepted' && paid
        && schedule.installment && schedule.balanceStatus === 'pending';
    // An event's venue booking is cancelled with the event, not on its own.
    const forEvent = booking && booking.event && typeof booking.event === 'object' ? booking.event : null;
    const canCancel = !!booking && !booking.event && (booking.status === 'pending' || booking.status === 'accepted');
    const location = [booking?.venue?.address?.city, booking?.venue?.address?.state].filter(Boolean).join(', ');
    const cover = booking?.venue?.images?.[0];

    return (
        <DashboardLayout>
            <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
                <SlideUp>
                    <Link href="/dashboard/bookings" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white mb-5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                        My bookings
                    </Link>
                </SlideUp>

                {loading ? (
                    <div className="h-72 bg-white/[0.04] rounded-2xl animate-pulse" />
                ) : error || !booking ? (
                    <div className="mt-10 text-center">
                        <p className="text-red-400 mb-4">{error || 'Booking not found'}</p>
                        <Button onClick={() => router.push('/dashboard/bookings')}>Back to my bookings</Button>
                    </div>
                ) : (
                    <FadeIn animateOnMount>
                        {/* Who, when, and where it stands. */}
                        <header className="flex items-start gap-4">
                            {cover ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={cover} alt="" className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl object-cover border border-white/10 shrink-0" />
                            ) : (
                                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-2xl font-bold text-violet-200 shrink-0" aria-hidden>
                                    {booking.venue?.name?.charAt(0)?.toUpperCase() || 'V'}
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <h1 className="text-2xl sm:text-3xl font-bold text-white break-words">{booking.venue?.name || 'Booking'}</h1>
                                <p className="text-gray-300 mt-1">{formatBookingDates(booking.bookingDate, booking.endDate)}</p>
                                {location && <p className="text-gray-500 text-sm">{location}</p>}
                                <span className={`inline-block mt-2 px-2.5 py-0.5 rounded-full text-xs font-medium border ${stageTone(booking)}`}>
                                    {stageOf(booking)}
                                </span>
                            </div>
                        </header>

                        {!ended && (
                            <div className="mt-8 mb-2 max-w-xl">
                                <Progress booking={booking} />
                            </div>
                        )}

                        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start">
                            {/* The booking itself. */}
                            <section className="bg-white/[0.02] border border-white/[0.08] rounded-2xl p-5 order-2 lg:order-1">
                                <h2 className="text-base font-semibold text-white mb-4">Your booking</h2>
                                <dl className="space-y-3 text-sm">
                                    {[
                                        [booking.endDate ? 'Dates' : 'Date', formatBookingDates(booking.bookingDate, booking.endDate)],
                                        ['Time', `${booking.startTime} to ${booking.endTime}`],
                                        ['Guests', `${booking.expectedGuests} people`],
                                        ['Purpose', booking.purpose || 'Not given'],
                                        ['Location', location || 'Not given'],
                                        ['Booking total', inr(booking.totalAmount)],
                                    ].map(([label, value]) => (
                                        <div key={label} className="flex items-baseline justify-between gap-4">
                                            <dt className="text-gray-400 shrink-0">{label}</dt>
                                            <dd className="text-gray-100 text-right min-w-0 break-words">{value}</dd>
                                        </div>
                                    ))}
                                </dl>
                                <p className="text-xs text-gray-500 mt-4">
                                    The booking total is what the venue charges. The platform fee and GST are added to each payment and are not refundable.
                                </p>
                            </section>

                            {/* Money: what is paid, what is due, and the buttons to pay it. */}
                            <section className="bg-white/[0.03] border border-violet-500/25 rounded-2xl p-5 space-y-5 order-1 lg:order-2">
                                <h2 className="text-base font-semibold text-white">Payment</h2>

                                {awaitingVenue && (
                                    <div className="space-y-2 text-sm text-gray-300">
                                        <p>Nothing to pay yet.</p>
                                        <p className="text-gray-400">
                                            The venue has
                                            {booking.ownerResponse?.respondBy ? ` until ${formatDue(booking.ownerResponse.respondBy)}` : ' a short while'} to accept.
                                            Then you pay {schedule?.installment
                                                ? `a 10% advance (${inr(schedule.upfront)}) or the full ${inr(booking.totalAmount)}`
                                                : `the full ${inr(booking.totalAmount)}`}, plus fees, to confirm.
                                        </p>
                                    </div>
                                )}

                                {canPayUpfront && (
                                    <>
                                        <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-sm text-amber-200">
                                            {forEvent ? (
                                                <>
                                                    The venue approved your event <span className="font-semibold">{forEvent.name}</span>. Pay the venue in full
                                                    {booking.paymentDueAt ? ` by ${formatDue(booking.paymentDueAt)}` : ''}: your event goes live once it is paid
                                                    (and approved by FIRA). If it isn&apos;t paid in time, the event is cancelled and the dates released.
                                                </>
                                            ) : (
                                                <>
                                                    The venue accepted. Pay{booking.paymentDueAt ? ` by ${formatDue(booking.paymentDueAt)}` : ''} to confirm,
                                                    or the booking is cancelled and the date released.
                                                </>
                                            )}
                                        </div>

                                        <div className={`grid gap-4 ${schedule?.installment ? 'sm:grid-cols-2' : ''}`}>
                                            {schedule?.installment && (
                                                <div className="rounded-xl border border-violet-500/40 bg-violet-500/[0.06] p-4 flex flex-col gap-4">
                                                    <div>
                                                        <h3 className="text-white font-medium">Pay a 10% advance</h3>
                                                        <p className="text-xs text-gray-400 mt-0.5">
                                                            Then {inr(schedule.balance)} plus fees by {formatDue(schedule.balanceDueAt)}.
                                                        </p>
                                                    </div>
                                                    <Charge amount={schedule.upfront} feePct={feePct} label="Advance" />
                                                    <Button className="w-full mt-auto" onClick={() => handlePay('advance')} disabled={!!busy}>
                                                        {busy === 'advance' ? 'Opening checkout…' : 'Pay advance'}
                                                    </Button>
                                                </div>
                                            )}
                                            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-4">
                                                <div>
                                                    <h3 className="text-white font-medium">Pay in full</h3>
                                                    <p className="text-xs text-gray-400 mt-0.5">Nothing left to pay later.</p>
                                                </div>
                                                <Charge amount={booking.totalAmount} feePct={feePct} label="Booking total" />
                                                <Button
                                                    className="w-full mt-auto"
                                                    variant={schedule?.installment ? 'secondary' : undefined}
                                                    onClick={() => handlePay('full')}
                                                    disabled={!!busy}
                                                >
                                                    {busy === 'full' ? 'Opening checkout…' : 'Pay in full'}
                                                </Button>
                                            </div>
                                        </div>
                                    </>
                                )}

                                {paid && (
                                    <div className="space-y-3">
                                        <PaidRow
                                            label={schedule?.installment ? 'Advance (10%)' : 'Booking total'}
                                            amount={schedule?.installment ? schedule.upfront : booking.totalAmount}
                                        />
                                        {schedule?.installment && schedule.balanceStatus === 'paid' && (
                                            <PaidRow label="Remaining amount" amount={schedule.balance} />
                                        )}
                                    </div>
                                )}

                                {canPayBalance && schedule && (
                                    <div className="rounded-xl border border-violet-500/40 bg-violet-500/[0.06] p-4 space-y-4">
                                        <div>
                                            <h3 className="text-white font-medium">Pay the remaining amount</h3>
                                            <p className="text-xs text-gray-400 mt-0.5">
                                                Due by {formatDue(schedule.balanceDueAt)}. If it is not paid by then, the booking is cancelled
                                                and the advance is not refunded. We remind you daily from 7 days before.
                                            </p>
                                        </div>
                                        <Charge amount={schedule.balance} feePct={feePct} label="Remaining (90%)" />
                                        <Button className="w-full" onClick={() => handlePay('balance')} disabled={!!busy}>
                                            {busy === 'balance' ? 'Opening checkout…' : 'Pay remaining amount'}
                                        </Button>
                                    </div>
                                )}

                                {paid && booking.status === 'pending' && (
                                    <p className="text-sm text-gray-400">
                                        Waiting for the venue to confirm. If it declines, everything you paid except the platform fee and GST is refunded.
                                    </p>
                                )}

                                {paid && !canPayBalance && booking.status === 'accepted' && (
                                    <p className="text-sm text-emerald-300">Fully paid. You&apos;re all set.</p>
                                )}

                                {ended && (
                                    <p className="text-sm text-gray-400">
                                        {paid
                                            ? 'Any refund under the venue\'s cancellation policy is processed by the FIRA team.'
                                            : 'Nothing was paid for this booking.'}
                                    </p>
                                )}
                            </section>
                        </div>

                        {confirmingCancel && (
                            <div className="mt-6 bg-red-500/10 border border-red-500/30 rounded-2xl p-5 space-y-3">
                                <p className="text-sm text-gray-200">
                                    {paid
                                        ? "Cancel this booking? You get back what the venue's cancellation policy allows for the time left (the platform fee and GST are not refunded). The FIRA team processes the refund."
                                        : 'Cancel this request? Nothing has been paid, so there is nothing to refund.'}
                                </p>
                                <div className="flex flex-col sm:flex-row gap-3">
                                    <Button className="bg-red-600 hover:bg-red-500" onClick={handleCancel} disabled={!!busy}>
                                        {busy === 'cancel' ? 'Cancelling…' : paid ? 'Cancel booking' : 'Cancel request'}
                                    </Button>
                                    <Button variant="secondary" onClick={() => setConfirmingCancel(false)} disabled={!!busy}>
                                        Keep it
                                    </Button>
                                </div>
                            </div>
                        )}

                        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:items-center gap-3">
                            {canCancel && !confirmingCancel && (
                                <Button variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => setConfirmingCancel(true)} disabled={!!busy}>
                                    {paid ? 'Cancel booking' : 'Cancel request'}
                                </Button>
                            )}
                            {forEvent && (
                                <p className="text-sm text-gray-400">
                                    This booking is for your event.{' '}
                                    <Link href={`/events/${forEvent._id}`} className="text-violet-400 hover:text-violet-300">Open the event</Link>
                                    {' '}to manage or cancel it; any refund follows the venue&apos;s policy.
                                </p>
                            )}
                            {booking.venue?._id && (
                                <Link href={`/venues/${booking.venue._id}`} className="sm:ml-auto">
                                    <Button variant="secondary" className="w-full sm:w-auto">View venue</Button>
                                </Link>
                            )}
                        </div>
                    </FadeIn>
                )}
            </div>
        </DashboardLayout>
    );
}
