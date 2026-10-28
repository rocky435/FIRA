'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import DashboardLayout from '@/components/dashboard/DashboardLayout';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { bookingsApi } from '@/lib/api';
import { FadeIn, SlideUp } from '@/components/animations';

interface Booking {
    _id: string;
    venue: { _id: string; name: string; images?: string[]; address?: { city?: string; state?: string } };
    bookingDate: string;
    startTime: string;
    endTime: string;
    purpose?: string;
    expectedGuests: number;
    status: string;
    paymentStatus: string;
    totalAmount: number;
    cancellationReason?: string | null;
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

const statusStyle = (status: string) => {
    switch (status) {
        case 'accepted': return 'bg-green-500/20 text-green-400 border-green-500/20';
        case 'pending': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/20';
        case 'completed': return 'bg-blue-500/20 text-blue-400 border-blue-500/20';
        case 'cancelled':
        case 'rejected': return 'bg-red-500/20 text-red-400 border-red-500/20';
        default: return 'bg-gray-500/20 text-gray-300 border-gray-500/20';
    }
};

const inr = (n: number | undefined) => `₹${(n || 0).toLocaleString('en-IN')}`;

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
    const [busy, setBusy] = useState(false);

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
        setBusy(true);
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
                modal: { ondismiss: () => setBusy(false) },
            });
            razorpay.open();
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to initiate payment', 'error');
        } finally {
            setBusy(false);
        }
    };

    const [confirmingCancel, setConfirmingCancel] = useState(false);
    const handleCancel = async () => {
        if (!user?._id || !booking) return;
        setBusy(true);
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
            setBusy(false);
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

    const formatDate = (value: string) =>
        new Date(value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const schedule = booking ? scheduleOf(booking) : null;
    const formatDue = (value: string | null) =>
        value ? new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const canPayUpfront = !!booking && booking.status === 'accepted' && booking.paymentStatus !== 'paid';
    const awaitingVenue = !!booking && booking.status === 'pending' && booking.paymentStatus !== 'paid';
    const canPayBalance = !!booking && !!schedule && booking.status === 'accepted'
        && schedule.installment && schedule.balanceStatus === 'pending';
    const canCancel = !!booking && (booking.status === 'pending' || booking.status === 'accepted');

    return (
        <DashboardLayout>
            <div className="p-6 lg:p-8 max-w-3xl">
                <SlideUp>
                    <Link href="/dashboard/bookings" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white mb-4">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                        Back to My Bookings
                    </Link>
                    <h1 className="text-2xl sm:text-3xl font-bold text-white">
                        {loading ? 'Booking' : (booking?.venue?.name || 'Booking')}
                    </h1>
                </SlideUp>

                {loading ? (
                    <div className="mt-6 h-64 bg-white/[0.04] rounded-2xl animate-pulse" />
                ) : error || !booking ? (
                    <div className="mt-10 text-center">
                        <p className="text-red-400 mb-4">{error || 'Booking not found'}</p>
                        <Button onClick={() => router.push('/dashboard/bookings')}>Back to My Bookings</Button>
                    </div>
                ) : (
                    <FadeIn animateOnMount>
                        <div className="mt-6 space-y-6">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusStyle(booking.status)}`}>
                                    {stageOf(booking)}
                                </span>
                            </div>

                            <div className="bg-white/[0.02] border border-white/[0.08] rounded-2xl p-5">
                                <h2 className="text-sm font-semibold text-white mb-4">Booking</h2>
                                <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                                    {[
                                        ['Date', formatDate(booking.bookingDate)],
                                        ['Time', `${booking.startTime} - ${booking.endTime}`],
                                        ['Guests', `${booking.expectedGuests} people`],
                                        ['Purpose', booking.purpose || 'Not specified'],
                                        ['Location', [booking.venue?.address?.city, booking.venue?.address?.state].filter(Boolean).join(', ') || '—'],
                                    ].map(([label, value]) => (
                                        <div key={label} className="flex items-baseline justify-between gap-4">
                                            <dt className="text-gray-400 shrink-0">{label}</dt>
                                            <dd className="text-gray-200 text-right min-w-0 break-words">{value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </div>

                            <div className="bg-gradient-to-br from-violet-500/10 to-pink-500/10 rounded-2xl p-5 border border-violet-500/20">
                                <h2 className="text-sm font-semibold text-white mb-3">Payment summary</h2>
                                <dl className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <dt className="text-gray-300">Total amount</dt>
                                        <dd className="text-white">{inr(booking.totalAmount)}</dd>
                                    </div>
                                    {booking.paymentStatus === 'paid' && (
                                        <div className="flex justify-between">
                                            <dt className="text-gray-300">{schedule?.installment ? 'Advance (10%)' : 'Paid in full'}</dt>
                                            <dd className="text-emerald-400">{inr(schedule?.upfront)} · paid</dd>
                                        </div>
                                    )}
                                    {booking.paymentStatus !== 'paid' && schedule?.installment && (
                                        <div className="flex justify-between">
                                            <dt className="text-gray-300">Advance option (10%)</dt>
                                            <dd className="text-violet-400">{inr(schedule.upfront)}</dd>
                                        </div>
                                    )}
                                    {booking.paymentStatus === 'paid' && schedule?.installment && (
                                        <div className="border-t border-white/10 pt-2 flex justify-between font-medium">
                                            <dt className="text-gray-300">Remaining</dt>
                                            <dd className={schedule.balanceStatus === 'paid' ? 'text-emerald-400' : 'text-white'}>
                                                {inr(schedule.balance)} {schedule.balanceStatus === 'paid' ? '· paid' : ''}
                                            </dd>
                                        </div>
                                    )}
                                </dl>
                                <p className="text-gray-400 text-xs mt-3">
                                    The platform fee and GST are added at checkout and are not refundable.
                                </p>
                                {awaitingVenue && (
                                    <p className="text-gray-300 text-xs mt-2">
                                        Nothing to pay yet. The venue has
                                        {booking.ownerResponse?.respondBy ? ` until ${formatDue(booking.ownerResponse.respondBy)}` : ' a short while'} to accept
                                        your request; then you pay {schedule?.installment ? 'a 10% advance or the full amount' : 'the full amount'} to confirm it.
                                    </p>
                                )}
                                {canPayUpfront && (
                                    <p className="text-yellow-400 text-xs mt-2">
                                        The venue accepted your request. Pay {schedule?.installment ? 'the 10% advance or the full amount' : 'the full amount'}
                                        {booking.paymentDueAt ? ` by ${formatDue(booking.paymentDueAt)}` : ''} to confirm it - otherwise the booking is
                                        cancelled and the date released.
                                        {schedule?.installment ? ` With the advance, the rest is due by ${formatDue(schedule.balanceDueAt)}; we remind you daily from 7 days before.` : ''}
                                    </p>
                                )}
                                {booking.paymentStatus === 'paid' && schedule?.installment && schedule.balanceStatus === 'pending' && booking.status === 'accepted' && (
                                    <p className="text-yellow-400 text-xs mt-2">
                                        Pay the remaining amount here in the app by {formatDue(schedule.balanceDueAt)}. If it is not paid by then, the booking is cancelled and the advance is not refunded.
                                    </p>
                                )}
                                {booking.status === 'pending' && booking.paymentStatus === 'paid' && (
                                    <p className="text-gray-300 text-xs mt-2">
                                        If the venue declines, everything you paid (except the platform fee and GST) is refunded.
                                    </p>
                                )}
                            </div>

                            {confirmingCancel && (
                                <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 space-y-3">
                                    <p className="text-sm text-gray-200">
                                        {booking.paymentStatus === 'paid'
                                            ? "Cancel this booking? You will get back what the venue's cancellation policy allows for the time left before your booking (the platform fee and GST are not refunded). The FIRA team processes the refund."
                                            : 'Cancel this booking request? Nothing has been paid, so there is nothing to refund.'}
                                    </p>
                                    <div className="flex gap-3">
                                        <Button className="bg-red-600 hover:bg-red-500" onClick={handleCancel} disabled={busy}>
                                            {busy ? 'Cancelling...' : 'Yes, cancel'}
                                        </Button>
                                        <Button variant="secondary" onClick={() => setConfirmingCancel(false)} disabled={busy}>
                                            Keep booking
                                        </Button>
                                    </div>
                                </div>
                            )}

                            <div className="flex flex-wrap gap-3">
                                {canPayUpfront && schedule?.installment && (
                                    <Button onClick={() => handlePay('advance')} disabled={busy}>
                                        {busy ? 'Processing...' : `Pay 10% advance ${inr(schedule.upfront)} + fees`}
                                    </Button>
                                )}
                                {canPayUpfront && (
                                    <Button variant={schedule?.installment ? 'secondary' : undefined} onClick={() => handlePay('full')} disabled={busy}>
                                        {busy ? 'Processing...' : `Pay in full ${inr(booking.totalAmount)} + fees`}
                                    </Button>
                                )}
                                {canPayBalance && (
                                    <Button onClick={() => handlePay('balance')} disabled={busy}>
                                        {busy ? 'Processing...' : `Pay remaining ${inr(schedule?.balance)} + fees`}
                                    </Button>
                                )}
                                {canCancel && !confirmingCancel && (
                                    <Button variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => setConfirmingCancel(true)} disabled={busy}>
                                        {booking.paymentStatus !== 'paid' ? 'Cancel Request' : 'Cancel Booking'}
                                    </Button>
                                )}
                                {booking.venue?._id && (
                                    <Link href={`/venues/${booking.venue._id}`}>
                                        <Button variant="secondary">View Venue</Button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    </FadeIn>
                )}
            </div>
        </DashboardLayout>
    );
}
