/*
 * API journeys: boots the real server (server/index.js, every route and
 * middleware) on an in-memory MongoDB, with email and Razorpay stubbed, then
 * walks the platform's user journeys over HTTP - sign up, list a venue, book
 * it, pay, cancel, refund, run an event, sell and scan tickets, creators,
 * inquiries, removal - and prints PASS/FAIL per check. Exits 1 if any fail.
 *
 * Usage: node e2e/api-journeys.js server     (npm run test:e2e)
 */
const path = require('path');
const crypto = require('crypto');
const serverDir = path.resolve(process.argv[2]);
const req = (m) => require(require.resolve(m, { paths: [serverDir] }));

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  ->  ' + detail}`);
}

// ---- Razorpay stub ------------------------------------------------------
let orderSeq = 0, refundSeq = 0;
const refundsIssued = [];
class FakeRazorpay {
    constructor() {
        this.orders = { create: async (o) => ({ id: `order_${++orderSeq}`, amount: o.amount, currency: o.currency, receipt: o.receipt }) };
        this.payments = { refund: async (payId, o) => { refundsIssued.push({ payId, amount: o.amount }); return { id: `rfnd_${++refundSeq}`, status: 'processed', amount: o.amount }; } };
    }
}
const rzpPath = require.resolve('razorpay', { paths: [serverDir] });
require.cache[rzpPath] = { id: rzpPath, filename: rzpPath, loaded: true, exports: FakeRazorpay };

const RZP_SECRET = 'rzp_test_secret';
const sign = (orderId, payId) => crypto.createHmac('sha256', RZP_SECRET).update(`${orderId}|${payId}`).digest('hex');

(async () => {
    const { MongoMemoryServer } = req('mongodb-memory-server');
    const mongo = await MongoMemoryServer.create();
    const PORT = 5055;
    Object.assign(process.env, {
        MONGODB_URI: mongo.getUri('fira'), JWT_SECRET: 'e2e-secret', PORT: String(PORT),
        CORS_ALLOWED_ORIGINS: 'http://localhost:3000', NODE_ENV: 'development',
        RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: RZP_SECRET,
    });
    delete process.env.REDIS_HOST;

    // ---- Email stub: capture every mail, pull OTPs out of them ----------
    const mails = [];
    const emailService = require(path.join(serverDir, 'services/emailService'));
    const fakeTransport = { sendMail: async (m) => { mails.push(m); return { messageId: 'x' }; }, verify: async () => true };
    emailService.transporter = fakeTransport;
    const lastCodeFor = (email) => {
        for (let i = mails.length - 1; i >= 0; i--) {
            const m = mails[i];
            if (String(m.to).includes(email)) {
                const body = String(m.html || m.text || '');
                const code = body.match(/otp-code[^>]*>\s*(\d{4,6})/) || body.match(/(?<![#\w])(\d{6})(?!\w)/);
                if (code) return code[1];
            }
        }
        return null;
    };

    require(path.join(serverDir, 'index.js'));
    const mongoose = req('mongoose');
    await new Promise(r => setTimeout(r, 3000));
    emailService.transporter = fakeTransport; // in case init replaced it

    const BASE = `http://localhost:${PORT}/api`;
    async function api(method, p, { token, body, raw } = {}) {
        const headers = { Origin: 'http://localhost:3000' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        let data = null;
        try { data = await res.json(); } catch { /* empty */ }
        return { status: res.status, data };
    }
    const db = mongoose.connection.db;
    const bcrypt = req('bcryptjs');
    const PASS = 'Fira@12345';

    async function seedUser(name, extra = {}) {
        const _id = new mongoose.Types.ObjectId();
        await db.collection('users').insertOne({ _id, name, email: `${name}@e2e.test`, password: await bcrypt.hash(PASS, 4),
            role: 'user', roles: ['user'], emailVerified: true, isBlocked: false, tokenVersion: 0, createdAt: new Date(), ...extra });
        const login = await api('POST', '/auth/login', { body: { email: `${name}@e2e.test`, password: PASS } });
        return { id: String(_id), token: login.data && login.data.token, email: `${name}@e2e.test` };
    }

    try {
        // ================= Accounts =================
        const r1 = await api('POST', '/auth/register', { body: { name: 'Riya', email: 'riya@e2e.test', password: PASS, city: 'Hyderabad' } });
        check('signup returns 201', r1.status === 201, JSON.stringify(r1.data));
        const otp = lastCodeFor('riya@e2e.test');
        check('signup email carries a 6-digit code', otp && otp.length === 6, `code=${otp}`);
        const badLogin = await api('POST', '/auth/login', { body: { email: 'riya@e2e.test', password: PASS } });
        check('login before verifying email is refused', badLogin.status === 401 && /EMAIL_NOT_VERIFIED/.test(JSON.stringify(badLogin.data)), JSON.stringify(badLogin.data));
        const v = await api('POST', '/auth/verify-otp', { body: { email: 'riya@e2e.test', code: otp } });
        check('verify OTP signs the user in', v.status === 200 && v.data.token, JSON.stringify(v.data));
        const wrong = await api('POST', '/auth/login', { body: { email: 'riya@e2e.test', password: 'nope' } });
        check('wrong password -> 401', wrong.status === 401);
        const login = await api('POST', '/auth/login', { body: { email: 'riya@e2e.test', password: PASS } });
        check('login with email + password works', login.status === 200 && login.data.token);
        let riya = { token: login.data.token, id: login.data.user._id };
        const me = await api('GET', '/auth/me', { token: riya.token });
        check('/auth/me returns the user', me.status === 200 && me.data.user.email === 'riya@e2e.test');
        const upd = await api('PUT', `/users/${riya.id}`, { token: riya.token, body: { name: 'Riya S', phone: '9999999999' } });
        check('profile update saves name/phone', upd.status === 200 && upd.data.name === 'Riya S', JSON.stringify(upd.data));

        const fp = await api('POST', '/auth/forgot-password', { body: { email: 'riya@e2e.test' } });
        check('forgot password sends a code', fp.status === 200, JSON.stringify(fp.data));
        const rcode = lastCodeFor('riya@e2e.test');
        const vr = await api('POST', '/auth/verify-reset-otp', { body: { email: 'riya@e2e.test', code: rcode } });
        check('reset code verifies', vr.status === 200 && vr.data.resetToken, JSON.stringify(vr.data));
        const rp = await api('POST', '/auth/reset-password', { body: { resetToken: vr.data.resetToken, newPassword: 'Fira@54321' } });
        check('password reset succeeds', rp.status === 200, JSON.stringify(rp.data));
        const oldSess = await api('GET', '/auth/me', { token: riya.token });
        check('old session ends after reset', oldSess.status === 401);
        const relog = await api('POST', '/auth/login', { body: { email: 'riya@e2e.test', password: 'Fira@54321' } });
        check('login with new password', relog.status === 200);
        riya = { token: relog.data.token, id: relog.data.user._id };

        // ================= Venue owner + venue =================
        const owner0 = await seedUser('owner');
        const bvo = await api('POST', '/auth/become-venue-owner', { token: owner0.token, body: {
            businessName: 'Hall Co', businessPhone: '9876543210', bankAccountName: 'Owner', bankAccountNumber: '123456789012',
            bankIfscCode: 'HDFC0001234', bankName: 'HDFC' } });
        check('become venue owner', bvo.status === 200 && bvo.data.user.roles.includes('venue_owner'), JSON.stringify(bvo.data));
        const owner = { ...owner0, token: bvo.data.token };
        const cv = await api('POST', '/venues', { token: owner.token, body: {
            name: 'Grand Hall', description: 'A hall', capacity: { min: 10, max: 200 },
            pricing: { basePrice: 10000, pricePerDay: 10000 },
            address: { street: '1 Road', city: 'Hyderabad', state: 'Telangana', pincode: '500001' },
            locationLink: 'https://maps.google.com/?q=hall', images: ['https://example.com/a.jpg'] } });
        check('create venue -> 201 pending', cv.status === 201 && cv.data.status === 'pending', JSON.stringify(cv.data).slice(0, 300));
        const venueId = cv.data && cv.data._id;
        const pubBefore = await api('GET', '/venues');
        check('pending venue not publicly listed', !JSON.stringify(pubBefore.data).includes('Grand Hall'));

        const admin = await seedUser('admin', { role: 'admin', roles: ['admin'], adminRole: 'super_admin' });

        // A venue is approved only once an admin has checked its owner's ID.
        const noId = await api('PUT', `/admin/venues/${venueId}/status`, { token: admin.token, body: { status: 'approved' } });
        check('venue approval refused before the owner ID is verified', noId.status === 400 && /government ID/.test(noId.data.error), JSON.stringify(noId.data));
        const idDoc = 'https://res.cloudinary.com/demo/image/upload/v1/fira/gov-ids/e2e-owner.jpg';
        const sub = await api('PUT', '/users/me/identity/gov-id', { token: owner.token, body: { govIdType: 'aadhar', govIdNumber: '123412341234', govIdDocument: idDoc } });
        check('owner submits government ID -> pending', sub.status === 200 && sub.data.govId.status === 'pending', JSON.stringify(sub.data));
        const idQueue = await api('GET', '/admin/identity-checks', { token: admin.token });
        check('admin sees it in ID checks', idQueue.status === 200 && idQueue.data.users.some(u => String(u._id) === owner.id), JSON.stringify(idQueue.data).slice(0, 200));
        const ver = await api('PUT', `/admin/users/${owner.id}/identity/gov-id/review`, { token: admin.token, body: { action: 'verify' } });
        check('admin verifies the owner ID', ver.status === 200 && ver.data.govId.status === 'verified', JSON.stringify(ver.data));

        const appr = await api('PUT', `/admin/venues/${venueId}/status`, { token: admin.token, body: { status: 'approved' } });
        check('admin approves venue', appr.status === 200, JSON.stringify(appr.data).slice(0, 200));
        const self = await api('POST', '/bookings', { token: owner.token, body: { venue: venueId, bookingDate: '2030-01-10', startTime: '10:00', endTime: '14:00', purpose: 'Own', expectedGuests: 20 } });
        check('owner cannot book their own venue', self.status === 400 && /your own venue/.test(JSON.stringify(self.data)), JSON.stringify(self.data));
        const pubAfter = await api('GET', '/venues?city=Hyderabad');
        check('approved venue publicly listed', JSON.stringify(pubAfter.data).includes('Grand Hall'), JSON.stringify(pubAfter.data).slice(0, 200));

        // ================= Booking + payments =================
        const guest = await seedUser('guest');
        const day = new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10);
        const bk = await api('POST', '/bookings', { token: guest.token, body: {
            venue: venueId, bookingDate: day, startTime: '18:00', endTime: '23:00', expectedGuests: 50, purpose: 'Birthday', bookingType: 'personal' } });
        check('create booking -> 201', bk.status === 201, JSON.stringify(bk.data).slice(0, 300));
        const bookingId = bk.data && bk.data._id;
        check('a booking starts as a request - nothing charged', bk.data && bk.data.status === 'pending' && bk.data.paymentStatus === 'pending', JSON.stringify(bk.data).slice(0, 200));
        check('the owner has 48 hours to answer', bk.data && bk.data.ownerResponse && Math.abs(new Date(bk.data.ownerResponse.respondBy) - Date.now() - 48 * 3600000) < 60000,
            JSON.stringify(bk.data && bk.data.ownerResponse));
        const dup = await api('POST', '/bookings', { token: (await seedUser('guest2')).token, body: {
            venue: venueId, bookingDate: day, startTime: '10:00', endTime: '12:00', expectedGuests: 5, purpose: 'x', bookingType: 'personal' } });
        check('same day cannot be double-booked', dup.status === 400, JSON.stringify(dup.data));
        const ownerNotes = await api('GET', '/notifications', { token: owner.token });
        check('owner is notified of the request', JSON.stringify(ownerNotes.data).includes('booking_request'), JSON.stringify(ownerNotes.data).slice(0, 200));
        const tooEarly = await api('POST', `/bookings/${bookingId}/initiate-payment`, { token: guest.token });
        check('nothing can be paid before the owner accepts', tooEarly.status === 400, JSON.stringify(tooEarly.data));
        const acc = await api('PUT', `/bookings/${bookingId}/status`, { token: owner.token, body: { status: 'accepted' } });
        check('owner accepts', acc.status === 200 && acc.data.status === 'accepted', JSON.stringify(acc.data).slice(0, 200));
        const vd = await api('GET', `/venues/${venueId}`);
        check('accepted request holds the date on the venue', JSON.stringify(vd.data.unavailableDates || []).includes(day), JSON.stringify(vd.data.unavailableDates));
        const guestNotes = await api('GET', '/notifications', { token: guest.token });
        check('guest told to pay the advance or in full', JSON.stringify(guestNotes.data).includes('10% advance'), JSON.stringify(guestNotes.data).slice(0, 300));
        check('guest emailed to pay', mails.some(m => String(m.to).includes('guest@e2e.test') && /pay to confirm/.test(m.subject)));
        const ip = await api('POST', `/bookings/${bookingId}/initiate-payment`, { token: guest.token, body: { plan: 'advance' } });
        check('initiate advance payment', ip.status === 200 && ip.data.gatewayOrderId, JSON.stringify(ip.data).slice(0, 200));
        check('advance charge = 1000 + 5% fee + 18% GST (Rs 1059)', ip.data && ip.data.amount === 105900, `amount(paise)=${ip.data && ip.data.amount}`);
        const vp = await api('POST', `/bookings/${bookingId}/verify-payment`, { token: guest.token, body: {
            gatewayOrderId: ip.data.gatewayOrderId, gatewayPaymentId: 'pay_dep', gatewaySignature: sign(ip.data.gatewayOrderId, 'pay_dep') } });
        check('verify advance -> confirmed, balance due', vp.status === 200 && vp.data.booking.status === 'accepted' && vp.data.booking.paymentStatus === 'paid'
            && vp.data.booking.paymentSchedule.type === 'installment' && vp.data.booking.paymentSchedule.balanceStatus === 'pending', JSON.stringify(vp.data).slice(0, 300));
        const ownerNotes2 = await api('GET', '/notifications', { token: owner.token });
        check('owner is told the guest paid', JSON.stringify(ownerNotes2.data).includes('payment_success'), JSON.stringify(ownerNotes2.data).slice(0, 200));
        const ib = await api('POST', `/bookings/${bookingId}/initiate-balance-payment`, { token: guest.token });
        check('initiate balance payment (9000 + fee + GST)', ib.status === 200 && ib.data.amount === 953100, `status ${ib.status} amount ${ib.data && ib.data.amount}`);
        const vb = await api('POST', `/bookings/${bookingId}/verify-balance-payment`, { token: guest.token, body: {
            gatewayOrderId: ib.data.gatewayOrderId, gatewayPaymentId: 'pay_bal', gatewaySignature: sign(ib.data.gatewayOrderId, 'pay_bal') } });
        check('verify balance -> balance paid', vb.status === 200 && vb.data.booking.paymentSchedule.balanceStatus === 'paid', JSON.stringify(vb.data).slice(0, 200));
        const day2 = new Date(Date.now() + 26 * 86400000).toISOString().slice(0, 10);
        const guest3 = await seedUser('guest3');
        const bk2 = await api('POST', '/bookings', { token: guest3.token, body: {
            venue: venueId, bookingDate: day2, startTime: '18:00', endTime: '23:00', expectedGuests: 50, purpose: 'Wedding', bookingType: 'personal' } });
        await api('PUT', `/bookings/${bk2.data._id}/status`, { token: owner.token, body: { status: 'accepted' } });
        const ipFull = await api('POST', `/bookings/${bk2.data._id}/initiate-payment`, { token: guest3.token, body: { plan: 'full' } });
        check('pay in full = 10000 + 500 fee + 90 GST (Rs 10590)', ipFull.status === 200 && ipFull.data.amount === 1059000, `status ${ipFull.status} amount ${ipFull.data && ipFull.data.amount}`);
        const vFull = await api('POST', `/bookings/${bk2.data._id}/verify-payment`, { token: guest3.token, body: {
            gatewayOrderId: ipFull.data.gatewayOrderId, gatewayPaymentId: 'pay_full', gatewaySignature: sign(ipFull.data.gatewayOrderId, 'pay_full') } });
        check('paid in full -> nothing left to pay', vFull.status === 200 && vFull.data.booking.paymentSchedule.type === 'full', JSON.stringify(vFull.data).slice(0, 200));
        const day3 = new Date(Date.now() + 27 * 86400000).toISOString().slice(0, 10);
        const bk3 = await api('POST', '/bookings', { token: guest3.token, body: {
            venue: venueId, bookingDate: day3, startTime: '18:00', endTime: '23:00', expectedGuests: 50, purpose: 'Party', bookingType: 'personal' } });
        const wd = await api('POST', `/bookings/${bk3.data._id}/cancel`, { token: guest3.token, body: {} });
        check('an unpaid request can be withdrawn, nothing to refund', wd.status === 200 && wd.data.refundStatus === 'none', JSON.stringify(wd.data));

        const ownerBookings = await api('GET', `/bookings/venue/${venueId}`, { token: owner.token });
        check('owner sees the booking', ownerBookings.status === 200 && JSON.stringify(ownerBookings.data).includes(bookingId));
        const refundsBefore = refundsIssued.length;
        const cancel = await api('POST', `/bookings/${bookingId}/cancel`, { token: guest.token, body: {} });
        check('guest cancels booking 25 days out', cancel.status === 200, JSON.stringify(cancel.data));
        check('cancelling raises refund requests for deposit + balance, and moves no money yet',
            refundsIssued.length === refundsBefore && cancel.data.refundStatus === 'pending_approval' && cancel.data.refundAmount === 10000,
            JSON.stringify(cancel.data));
        const queue = await api('GET', '/payments/refunds?status=pending', { token: admin.token });
        check('admin sees both refunds in the queue', queue.status === 200 && queue.data.refunds.length === 2, JSON.stringify(queue.data).slice(0, 200));
        for (const r of (queue.data && queue.data.refunds) || []) {
            await api('POST', `/payments/refunds/${r._id}/process`, { token: admin.token, body: { action: 'approve', reference: `UTR-${r.amount}` } });
        }
        const done = await api('GET', '/payments/refunds?status=completed', { token: admin.token });
        check('admin marks Rs 1,000 + Rs 9,000 refunded manually (no gateway call)',
            refundsIssued.length === refundsBefore && done.data.refunds.map(r => r.amount).sort((a, b) => a - b).join() === '1000,9000'
                && done.data.refunds.every(r => r.gatewayRefundId && r.gatewayRefundId.startsWith('UTR-')),
            JSON.stringify(done.data).slice(0, 300));
        const vd2 = await api('GET', `/venues/${venueId}`);
        check('cancelled booking frees the date', !JSON.stringify(vd2.data.unavailableDates || []).includes(day), JSON.stringify(vd2.data.unavailableDates));

        // ================= Event lifecycle =================
        const org = await seedUser('organizer');
        // Daytime in any Indian/European/US time zone, so it is one calendar day.
        const start = new Date(Date.now() + 40 * 86400000); start.setUTCHours(7, 0, 0, 0);
        const end = new Date(start.getTime() + 5 * 3600000);
        const ce = await api('POST', '/events', { token: org.token, body: {
            name: 'Neon Night', description: 'Party', venue: venueId, startDateTime: start.toISOString(), endDateTime: end.toISOString(),
            eventType: 'public', ticketType: 'paid', ticketPrice: 1000, maxAttendees: 30, category: 'party',
            ticketTiers: [{ name: 'VIP', price: 1000, maxQuantity: 10, description: '' }, { name: 'GA', price: 500, maxQuantity: 20, description: '' }] } });
        check('create event -> 201 pending', ce.status === 201 && ce.data.status === 'pending', JSON.stringify(ce.data).slice(0, 300));
        const eventId = ce.data && ce.data._id;
        const vr2 = await api('GET', '/events/venue-requests', { token: owner.token });
        check('venue owner sees the event request', JSON.stringify(vr2.data).includes('Neon Night'), JSON.stringify(vr2.data).slice(0, 200));
        const va = await api('POST', `/events/${eventId}/venue-approve`, { token: owner.token, body: { status: 'approved' } });
        check('venue owner approves', va.status === 200, JSON.stringify(va.data).slice(0, 200));
        const ap = await api('GET', '/events/admin-pending', { token: admin.token });
        check('event appears in admin queue', JSON.stringify(ap.data).includes('Neon Night'), JSON.stringify(ap.data).slice(0, 200));
        const aa = await api('POST', `/events/${eventId}/admin-approve`, { token: admin.token, body: { status: 'approved' } });
        // Approved by both, but not live until the organiser pays for the venue.
        check('admin approves -> still waiting for the venue payment', aa.status === 200 && aa.data.status === 'pending', JSON.stringify(aa.data).slice(0, 200));
        const notLive = await api('GET', '/events?eventType=public');
        check('unpaid event not publicly listed', !JSON.stringify(notLive.data).includes('Neon Night'));
        const orgBookings = await api('GET', '/bookings', { token: org.token });
        const venueBooking = [].concat(orgBookings.data && (orgBookings.data.bookings || orgBookings.data) || [])
            .find(b => String(b.event && (b.event._id || b.event)) === String(eventId));
        check('organiser has the venue booking to pay, full price', venueBooking && venueBooking.status === 'accepted'
            && venueBooking.paymentStatus === 'pending' && venueBooking.totalAmount === 10000, JSON.stringify(venueBooking).slice(0, 300));
        const ivp = await api('POST', `/bookings/${venueBooking && venueBooking._id}/initiate-payment`, { token: org.token, body: { plan: 'advance' } });
        check('event venue charged in full even when an advance is asked for (Rs 10,590)', ivp.status === 200 && ivp.data.amount === 1059000, `amount(paise)=${ivp.data && ivp.data.amount}`);
        const vvp = await api('POST', `/bookings/${venueBooking && venueBooking._id}/verify-payment`, { token: org.token, body: {
            gatewayOrderId: ivp.data.gatewayOrderId, gatewayPaymentId: 'pay_venue', gatewaySignature: sign(ivp.data.gatewayOrderId, 'pay_venue') } });
        check('venue paid -> event approved', vvp.status === 200 && vvp.data.booking.paymentStatus === 'paid', JSON.stringify(vvp.data).slice(0, 200));
        const live = await api('GET', `/events/${eventId}`);
        check('event live once the venue is paid', live.data && (live.data.status || (live.data.event && live.data.event.status)) === 'approved', JSON.stringify(live.data).slice(0, 200));
        const list = await api('GET', '/events?eventType=public');
        check('approved event publicly listed', JSON.stringify(list.data).includes('Neon Night'));

        // ================= Tickets =================
        const buyer = await seedUser('buyer');
        const p1 = await api('POST', '/tickets', { token: buyer.token, body: { eventId, quantity: 2, ticketType: 'VIP' } });
        check('buy 2 VIP -> payment required', p1.status === 201 && p1.data.paymentRequired, JSON.stringify(p1.data).slice(0, 200));
        check('VIP x2 charge = 2000 + 100 fee + 18 GST (Rs 2118)', p1.data.paymentData && p1.data.paymentData.amount === 211800, `paise=${p1.data.paymentData && p1.data.paymentData.amount}`);
        const pd = p1.data.paymentData;
        const vt = await api('POST', '/payments/verify', { token: buyer.token, body: {
            paymentId: pd.payment._id, gatewayOrderId: pd.gatewayOrderId, gatewayPaymentId: 'pay_t1', gatewaySignature: sign(pd.gatewayOrderId, 'pay_t1') } });
        check('verify ticket payment', vt.status === 200 && vt.data.success, JSON.stringify(vt.data).slice(0, 200));
        const p2 = await api('POST', '/tickets', { token: buyer.token, body: { eventId, quantity: 2, ticketType: 'VIP', paymentId: pd.payment._id } });
        check('redeem payment -> ticket issued', p2.status === 201 && p2.data.ticket && p2.data.ticket.ticketId, JSON.stringify(p2.data).slice(0, 200));
        const ticket = p2.data.ticket;
        const myT = await api('GET', `/tickets/user/${buyer.id}`, { token: buyer.token });
        check('ticket in My Tickets', myT.status === 200 && myT.data.length === 1);
        const evAfter = await api('GET', `/events/${eventId}`);
        check('attendee + tier counts updated', evAfter.data.currentAttendees === 2 && evAfter.data.ticketTiers.find(t => t.name === 'VIP').soldCount === 2,
            `attendees=${evAfter.data.currentAttendees}`);
        check('ticket confirmation email sent', mails.some(m => String(m.to).includes('buyer@e2e.test')));
        const notif = await api('GET', '/notifications', { token: buyer.token });
        check('buyer notified of ticket', JSON.stringify(notif.data).includes('ticket_purchased'), JSON.stringify(notif.data).slice(0, 200));
        const sales = await api('GET', '/admin/audit-trail?action=sale', { token: admin.token });
        check('the sale is on the admin audit trail', sales.status === 200 && JSON.stringify(sales.data).includes('Neon Night') && JSON.stringify(sales.data).includes('buyer@e2e.test'),
            JSON.stringify(sales.data).slice(0, 300));

        // Discount code
        const dc = await api('POST', `/discounts/events/${eventId}/discount-codes`, { token: org.token, body: { code: 'NEON10', discountType: 'percentage', discountValue: 10, maxUses: 5 } });
        check('organizer creates discount code', dc.status === 201, JSON.stringify(dc.data));
        const prev = await api('POST', '/payments/apply-discount', { token: buyer.token, body: { code: 'neon10', eventId, subtotal: 500 } });
        check('discount preview is 10% of the ticket price', prev.status === 200 && prev.data.discountAmount === 50, JSON.stringify(prev.data));
        const pd2 = await api('POST', '/tickets', { token: buyer.token, body: { eventId, quantity: 1, ticketType: 'GA', discountCode: 'NEON10' } });
        check('GA with NEON10 = 450 + full 25 fee + 4.50 GST (Rs 479.50)', pd2.data.paymentData && pd2.data.paymentData.amount === 47950, `paise=${pd2.data.paymentData && pd2.data.paymentData.amount}`);

        // Door check-in
        const sc = await api('GET', `/events/${eventId}/scanning-codes`, { token: org.token });
        check('organizer gets scanner links', sc.status === 200 && Array.isArray(sc.data) && sc.data.length > 0, JSON.stringify(sc.data).slice(0, 200));
        const vipCode = (sc.data || []).find(c => c.ticketTier === 'VIP') || (sc.data || [])[0];
        const ci = await api('POST', `/scan/${vipCode && vipCode.code}/checkin`, { body: { ticketId: ticket.ticketId } });
        check('door check-in admits the ticket', ci.status === 200, JSON.stringify(ci.data));
        const ci2 = await api('POST', `/scan/${vipCode && vipCode.code}/checkin`, { body: { ticketId: ticket.ticketId } });
        check('second scan refused', ci2.status === 400);

        // Earnings
        const earn = await api('GET', `/events/${eventId}/earnings`, { token: org.token });
        check('organizer earnings view loads', earn.status === 200, JSON.stringify(earn.data).slice(0, 200));
        const dash = await api('GET', `/dashboard/overview/${buyer.id}`, { token: buyer.token });
        check('buyer dashboard loads', dash.status === 200, JSON.stringify(dash.data).slice(0, 200));
        const ov = await api('GET', '/admin/earnings/overview', { token: admin.token });
        check('admin earnings overview loads', ov.status === 200, JSON.stringify(ov.data).slice(0, 200));

        // ================= Creator / brand =================
        const creator = await seedUser('creator');
        const ab = await api('POST', '/brands', { token: creator.token, body: { name: 'Beat Co', type: 'brand', bio: 'We throw parties' } });
        check('apply as creator -> pending profile', ab.status === 200 && ab.data.status === 'pending', JSON.stringify(ab.data).slice(0, 200));
        const brandId = ab.data._id;
        const abr = await api('PUT', `/admin/brands/${brandId}/status`, { token: admin.token, body: { status: 'approved' } });
        check('admin approves brand', abr.status === 200, JSON.stringify(abr.data).slice(0, 200));
        const meC = await api('GET', '/auth/me', { token: creator.token });
        check('approved creator gets badge', meC.data.user.verificationBadge && meC.data.user.verificationBadge !== 'none', JSON.stringify(meC.data.user.verificationBadge));
        const fol = await api('POST', `/brands/${brandId}/follow`, { token: buyer.token });
        check('user follows brand', fol.status === 200, JSON.stringify(fol.data));
        const bp = await api('POST', `/brands/${brandId}/posts`, { token: creator.token, body: { content: 'Hello fans' } });
        check('creator posts', bp.status === 201, JSON.stringify(bp.data).slice(0, 200));
        const postId = bp.data && bp.data._id;
        const ep = await api('PUT', `/brands/${brandId}/posts/${postId}`, { token: creator.token, body: { content: 'Edited' } });
        check('creator edits own post', ep.status === 200, JSON.stringify(ep.data));
        const cm = await api('POST', `/brands/${brandId}/posts/${postId}/comments`, { token: buyer.token, body: { content: 'Nice!' } });
        check('follower comments', cm.status === 200 || cm.status === 201, JSON.stringify(cm.data).slice(0, 200));
        const commentId = cm.data && ((Array.isArray(cm.data) ? cm.data : cm.data.comments || [])[0] || {})._id;
        const dcm = await api('DELETE', `/brands/${brandId}/posts/${postId}/comments/${commentId}`, { token: buyer.token });
        check('commenter deletes own comment', dcm.status === 200, JSON.stringify(dcm.data));
        const dp = await api('DELETE', `/brands/${brandId}/posts/${postId}`, { token: creator.token });
        check('creator deletes own post', dp.status === 200, JSON.stringify(dp.data));

        // ================= Inquiries + chat =================
        const iq = await api('POST', '/inquiries', { token: buyer.token, body: { referenceType: 'venue', referenceId: venueId, message: 'Is parking available for 30 cars?' } });
        check('user sends a venue inquiry', iq.status === 201, JSON.stringify(iq.data).slice(0, 200));
        // The website then opens the chat for that inquiry (InquiryForm.tsx).
        const sc2 = await api('POST', '/messages/start-inquiry-conversation', { token: buyer.token, body: { inquiryId: iq.data._id, message: 'Is parking available for 30 cars?' } });
        check('inquiry opens a chat thread', sc2.status === 200 || sc2.status === 201, JSON.stringify(sc2.data).slice(0, 200));
        const conv = await api('GET', '/messages/conversations', { token: owner.token });
        check('owner sees the inquiry conversation', conv.status === 200 && JSON.stringify(conv.data).includes('parking'), JSON.stringify(conv.data).slice(0, 300));

        // ================= Event cancellation =================
        const evc = await api('POST', `/events/${eventId}/cancel`, { token: org.token, body: { reason: 'Rain' } });
        check('organizer cancel with sold tickets goes to an admin', evc.status === 202 && evc.data.deletionRequested, JSON.stringify(evc.data).slice(0, 200));
        const adminList = await api('GET', '/admin/events', { token: admin.token });
        check('admin sees the removal request', JSON.stringify(adminList.data).includes('deletionRequest'), JSON.stringify(adminList.data).slice(0, 200));
        const adm = await api('DELETE', `/admin/events/${eventId}`, { token: admin.token });
        check('admin removes the event', adm.status === 200, JSON.stringify(adm.data).slice(0, 200));
        const used = await db.collection('tickets').findOne({ ticketId: ticket.ticketId });
        check('used tickets are not refunded on cancel (only active ones)', used.status === 'used', used.status);
        const vdEv = await db.collection('venues').findOne({ _id: new mongoose.Types.ObjectId(venueId) });
        const eventDay = start.toISOString().slice(0, 10);
        const stillBlocked = (vdEv.daySlots || []).some(s => s.isBooked && new Date(s.date).toISOString().slice(0, 10) === eventDay)
            || (vdEv.blockedDates || []).some(d => d.date === eventDay);
        check('cancelled event frees the venue date', !stillBlocked, `still blocked on ${eventDay}: ${JSON.stringify(vdEv.blockedDates)}`);
        const freed = await api('POST', '/bookings', { token: guest.token, body: {
            venue: venueId, bookingDate: eventDay, startTime: '10:00', endTime: '12:00', expectedGuests: 5, purpose: 'Meetup', bookingType: 'personal' } });
        check('the freed date can be booked again', freed.status === 201, JSON.stringify(freed.data).slice(0, 200));

        // ================= Account deletion =================
        const del = await api('DELETE', '/users/me', { token: riya.token });
        check('user deletes own account', del.status === 200, JSON.stringify(del.data));
        const after = await api('POST', '/auth/login', { body: { email: 'riya@e2e.test', password: 'Fira@54321' } });
        check('deleted account cannot log in', after.status === 401);
    } catch (err) {
        check('harness crashed', false, err.stack);
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    await mongo.stop().catch(() => {});
    process.exit(failed.length ? 1 : 0);
})();
