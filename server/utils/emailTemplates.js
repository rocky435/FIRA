/**
 * Email Templates for FIRA
 *
 * Every email shares one design (layout() below): the black page, the violet
 * "FIRA / Let's Celebrate" header, a dark card body and the same footer. Each
 * template only supplies its content, so the look cannot drift between emails
 * again - the reminder and cancellation emails had their own orange headers,
 * and several emails were plain unstyled HTML.
 *
 * Styles are inline and the structure is tables: Gmail, Outlook and Apple Mail
 * drop or ignore much of a <style> block, so anything that matters is inline.
 * Anything a user typed (names, venue and event names, posts) goes through esc().
 */

const { formatInr } = require('./formatInr');

const VIOLET = '#8b5cf6';
const GRADIENT = 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const clientUrl = (path = '') => `${process.env.CLIENT_URL || 'http://localhost:3000'}${path}`;
const supportEmail = () => process.env.SUPPORT_EMAIL || 'support@fira.com';

/** Escape text for HTML. Apostrophes are left alone: harmless in text, and names use them. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const enIN = (d, opts) => new Date(d).toLocaleString('en-IN', opts);
const longDate = (d) => enIN(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dateTime = (d) => enIN(d, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const timeOnly = (d) => enIN(d, { hour: 'numeric', minute: '2-digit' });

function venueNameOf(event) {
  return event.venue?.name || event.customVenue?.name || event.customVenue?.address || 'Venue to be announced';
}

// ---------------------------------------------------------------- building blocks

function paragraph(html, { muted = true, center = false, size = 16 } = {}) {
  return `<p style="margin: 0 0 18px; font-size: ${size}px; line-height: 1.7; color: ${muted ? '#a0a0a0' : '#ffffff'};${center ? ' text-align: center;' : ''}">${html}</p>`;
}

function button(label, url) {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 28px auto 8px;">
    <tr><td style="border-radius: 8px; background: ${VIOLET}; background-image: ${GRADIENT};">
      <a href="${url}" style="display: inline-block; padding: 14px 36px; font-family: ${FONT}; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/** A dark card of label/value rows, optionally under an image and a title. */
function detailsCard(rows, { image, title } = {}) {
  const body = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value, strong]) => `
      <tr>
        <td style="padding: 6px 0; font-size: 14px; color: #888888; vertical-align: top;">${esc(label)}</td>
        <td style="padding: 6px 0 6px 16px; font-size: ${strong ? 18 : 14}px; ${strong ? `font-weight: 700; color: ${VIOLET};` : 'color: #ffffff;'} text-align: right; vertical-align: top;">${value}</td>
      </tr>`).join('');
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #1a1a1a; border: 1px solid #333333; border-radius: 12px; margin: 8px 0 24px; overflow: hidden;">
    ${image ? `<tr><td><img src="${esc(image)}" alt="" width="100%" style="display: block; width: 100%; max-height: 220px; object-fit: cover; border-radius: 12px 12px 0 0;"></td></tr>` : ''}
    <tr><td style="padding: 18px 20px;">
      ${title ? `<div style="font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 8px;">${esc(title)}</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
    </td></tr>
  </table>`;
}

/** The highlighted code box (sign-up and password reset). Never wraps on a phone. */
function codeBox(code, note) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 24px;">
    <tr><td style="background: rgba(139, 92, 246, 0.1); border: 2px solid rgba(139, 92, 246, 0.3); border-radius: 12px; padding: 26px 12px; text-align: center;">
      <div style="font-size: 13px; color: #a0a0a0; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">Your code</div>
      <div style="font-family: 'Courier New', monospace; font-size: 34px; font-weight: 700; letter-spacing: 6px; color: ${VIOLET}; white-space: nowrap;">${esc(code)}</div>
      ${note ? `<div style="font-size: 14px; color: #ef4444; margin-top: 12px;">${esc(note)}</div>` : ''}
    </td></tr>
  </table>`;
}

/** A note box with a coloured edge: violet for tips, amber for warnings. */
function noteBox(lines, { tone = 'info', title } = {}) {
  const edge = tone === 'warn' ? '#f59e0b' : '#6366f1';
  const bg = tone === 'warn' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(99, 102, 241, 0.1)';
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 24px;">
    <tr><td style="background: ${bg}; border-left: 4px solid ${edge}; border-radius: 8px; padding: 16px 18px;">
      ${title ? `<div style="font-size: 14px; font-weight: 700; color: #ffffff; margin-bottom: 6px;">${title}</div>` : ''}
      ${lines.map(l => `<div style="font-size: 14px; line-height: 1.6; color: #c0c0c0; margin: 4px 0;">${l}</div>`).join('')}
    </td></tr>
  </table>`;
}

/** The ticket stub: id, QR code and admit count. */
function ticketStub({ ticketId, qrSrc, tier, quantity }) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff; border-radius: 12px; margin: 8px 0 24px;">
    <tr><td style="padding: 22px 20px; text-align: center; color: #000000;">
      <div style="font-size: 12px; color: #666666; text-transform: uppercase; letter-spacing: 1px;">Ticket ID</div>
      <div style="font-family: 'Courier New', monospace; font-size: 18px; font-weight: 700; margin: 6px 0 16px;">${esc(ticketId)}</div>
      ${qrSrc ? `<img src="${qrSrc}" alt="Ticket QR code" width="180" height="180" style="display: block; width: 180px; height: 180px; margin: 0 auto;">
      <div style="margin-top: 12px; font-size: 14px; color: #666666;">Scan this code at the entrance</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 18px; border-top: 1px dashed #cccccc;">
        <tr>
          <td style="padding-top: 14px; text-align: left;">
            <div style="font-size: 12px; color: #666666;">Tier</div>
            <div style="font-weight: 700; text-transform: capitalize;">${esc(tier)}</div>
          </td>
          <td style="padding-top: 14px; text-align: right;">
            <div style="font-size: 12px; color: #666666;">Admit</div>
            <div style="font-weight: 700;">${esc(quantity)} ${Number(quantity) === 1 ? 'person' : 'people'}</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}

/**
 * The one FIRA email design. `heading` is the big line under the header,
 * `body` the content blocks, `cta` an optional { label, url } button.
 */
function layout({ title, preheader = '', heading, body, cta }) {
  const year = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${esc(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #000000; font-family: ${FONT}; color: #ffffff;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #000000;">
    <tr><td align="center" style="padding: 20px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background: #0a0a0a; border-radius: 16px; overflow: hidden;">
        <tr><td style="background: ${VIOLET}; background-image: ${GRADIENT}; padding: 34px 24px; text-align: center;">
          <div style="font-size: 30px; font-weight: 800; letter-spacing: 3px; color: #ffffff;">FIRA</div>
          <div style="font-size: 14px; color: rgba(255, 255, 255, 0.9); margin-top: 6px;">Let's Celebrate</div>
        </td></tr>
        <tr><td style="padding: 32px 28px 24px;">
          ${heading ? `<h1 style="margin: 0 0 18px; font-size: 24px; line-height: 1.3; font-weight: 700; color: #ffffff;">${heading}</h1>` : ''}
          ${body}
          ${cta ? button(cta.label, cta.url) : ''}
        </td></tr>
        <tr><td style="background: #050505; padding: 24px; text-align: center; border-top: 1px solid #1f1f1f;">
          <div style="font-size: 13px; color: #777777; margin-bottom: 8px;">Need help? Contact us at <a href="mailto:${supportEmail()}" style="color: ${VIOLET}; text-decoration: none;">${supportEmail()}</a></div>
          <div style="font-size: 12px; color: #555555;">© ${year} FIRA - Let's Celebrate. All rights reserved.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

const hey = (name) => paragraph(`Hey ${esc(name || 'there')},`, { muted: false, size: 17 });

// ---------------------------------------------------------------- the emails

const emailTemplates = {
  esc,
  layout,

  /** Sign-up verification code. */
  otpVerification(name, otp) {
    return layout({
      title: 'Verify your email - FIRA',
      preheader: `${otp} is your FIRA verification code`,
      heading: `Hey ${esc(name || 'there')}! 👋`,
      body: [
        paragraph("Welcome to FIRA! We're excited to have you join our community of event lovers and venue owners."),
        paragraph('To finish signing up, enter this code in the app:'),
        codeBox(otp, 'This code expires in 10 minutes'),
        noteBox([
          '• Never share this code with anyone',
          '• FIRA will never ask for your code by phone or email',
          "• If you didn't request this code, you can ignore this email",
        ], { title: '🔒 Security tips' }),
        paragraph("Once verified, you'll be able to:<br>✨ Discover and book venues<br>🎉 Browse upcoming events<br>🎫 Buy tickets in seconds"),
      ].join(''),
    });
  },

  /** Password reset code. */
  passwordReset(name, otp) {
    return layout({
      title: 'Reset your password - FIRA',
      preheader: `${otp} is your FIRA password reset code`,
      heading: 'Reset your password',
      body: [
        hey(name),
        paragraph('We received a request to reset the password on your FIRA account. Enter this code to choose a new one:'),
        codeBox(otp, 'This code expires in 10 minutes'),
        noteBox(["If you didn't ask to reset your password, ignore this email - your password stays the same."]),
      ].join(''),
    });
  },

  /** After the email is verified. */
  welcome(name, role) {
    const isVenueOwner = role === 'venue_owner';
    return layout({
      title: 'Welcome to FIRA',
      preheader: "Your email is verified. Let's celebrate!",
      heading: 'Welcome to FIRA! 🎉',
      body: [
        hey(name),
        paragraph("Your email is verified - you're now part of the FIRA community."),
        paragraph(isVenueOwner
          ? 'As a venue owner, you can now list your spaces and take bookings from guests and event organisers.'
          : 'Start exploring venues and events near you!'),
      ].join(''),
      cta: { label: 'Go to dashboard', url: clientUrl(isVenueOwner ? '/venue-portal/dashboard' : '/dashboard') },
    });
  },

  /** Password changed. */
  passwordChanged(name) {
    return layout({
      title: 'Your password was changed - FIRA',
      preheader: 'Your FIRA password was just changed',
      heading: 'Your password was changed',
      body: [
        hey(name),
        paragraph('The password on your FIRA account was just changed.'),
        noteBox([`If this wasn't you, reset your password straight away and contact us at ${supportEmail()}.`], { tone: 'warn' }),
      ].join(''),
    });
  },

  /** Payout bank details changed: the signal of a takeover trying to redirect earnings. */
  payoutAccountChanged(name, change) {
    return layout({
      title: 'Your payout account was changed - FIRA',
      preheader: 'The bank account your earnings go to was changed',
      heading: 'Your payout account was changed',
      body: [
        hey(name),
        paragraph(`The bank account your FIRA earnings are paid to was just changed: <strong style="color: #ffffff;">${esc(change)}</strong>.`),
        noteBox(["If you didn't make this change, change your password now and contact us immediately - someone may be trying to redirect your earnings."], { tone: 'warn' }),
      ].join(''),
      cta: { label: 'Review payout accounts', url: clientUrl('/dashboard/settings') },
    });
  },

  /**
   * Ticket confirmation. `qrSrc` is where the QR image is read from: emailService
   * attaches it and passes 'cid:...', because most mail apps (Gmail among them)
   * block data: images - the QR showed as an empty box.
   */
  ticketConfirmation(userName, event, ticket, { qrSrc } = {}) {
    // The schema stores startDateTime, not date/startTime.
    const startsAt = new Date(event.startDateTime || event.date);
    const formattedDate = startsAt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const formattedTime = startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return layout({
      title: `Your ticket for ${event.name} - FIRA`,
      preheader: `You're going to ${event.name} on ${formattedDate}`,
      heading: "You're going! 🎉",
      body: [
        paragraph(`Hey ${esc(userName || 'there')}, your ticket is confirmed. Get ready for an amazing experience!`),
        detailsCard([
          ['Date', formattedDate],
          ['Time', formattedTime],
          ['Venue', esc(venueNameOf(event))],
          ['Tier', `<span style="text-transform: capitalize;">${esc(ticket.ticketType)}</span>`],
        ], { image: event.images && event.images[0], title: event.name }),
        ticketStub({ ticketId: ticket.ticketId, qrSrc: qrSrc || ticket.qrCode, tier: ticket.ticketType, quantity: ticket.quantity }),
        paragraph('Keep this email, or open your ticket any time from your dashboard.', { center: true, size: 13 }),
      ].join(''),
      cta: { label: 'View in Dashboard', url: clientUrl('/dashboard/tickets') },
    });
  },

  /** One hour before the event. */
  eventReminder(userName, event, ticket) {
    const startsAt = event.startDateTime ? new Date(event.startDateTime) : null;
    const address = [event.venue?.address?.street, event.venue?.address?.city].filter(Boolean).join(', ');
    return layout({
      title: `${event.name} starts in 1 hour - FIRA`,
      preheader: `${event.name} starts in 1 hour`,
      heading: '⏰ Starting in 1 hour',
      body: [
        paragraph(`Hey ${esc(userName || 'there')}, don't forget - your event is about to start!`),
        detailsCard([
          ['Starts', startsAt ? timeOnly(startsAt) : 'Very soon'],
          ['Venue', esc(venueNameOf(event))],
          ['Address', esc(address)],
        ], { image: event.images?.[0], title: event.name }),
        ticketStub({ ticketId: ticket.ticketId, tier: ticket.ticketType || 'General', quantity: ticket.quantity }),
        paragraph('Have a great time! 🎉', { center: true }),
      ].join(''),
      cta: { label: 'View my ticket', url: clientUrl('/dashboard/tickets') },
    });
  },

  /** A brand the user follows announced an event. */
  brandNewEvent(userName, brandName, event) {
    const price = Number(event.ticketPrice) > 0 ? formatInr(event.ticketPrice) : 'Free';
    return layout({
      title: `New event from ${brandName} - FIRA`,
      preheader: `${brandName} just announced ${event.name}`,
      heading: '🎉 New event',
      body: [
        paragraph(`Hey ${esc(userName || 'there')}, <strong style="color: ${VIOLET};">${esc(brandName)}</strong> just announced a new event!`),
        detailsCard([
          ['Date', longDate(event.startDateTime || event.date)],
          ['Venue', esc(event.venue?.name)],
          ['Tickets', price, true],
        ], { image: event.images?.[0], title: event.name }),
      ].join(''),
      cta: { label: 'Get tickets', url: clientUrl(`/events/${event._id}`) },
    });
  },

  /** A brand the user follows posted an update. */
  brandNewPost(userName, brandName, post) {
    const text = String(post.content || '');
    return layout({
      title: `New post from ${brandName} - FIRA`,
      preheader: `${brandName} shared an update`,
      heading: '📢 New update',
      body: [
        paragraph(`Hey ${esc(userName || 'there')}, <strong style="color: ${VIOLET};">${esc(brandName)}</strong> just shared something new!`),
        noteBox([
          esc(text.slice(0, 200)) + (text.length > 200 ? '…' : ''),
          post.images?.[0] ? `<img src="${esc(post.images[0])}" alt="" width="100%" style="display: block; width: 100%; border-radius: 8px; margin-top: 10px;">` : '',
        ]),
      ].join(''),
      cta: { label: 'View post', url: clientUrl(`/brands/${post.brandId}`) },
    });
  },

  /** To the venue owner: someone asked to book their venue. */
  venueBookingNotification(ownerName, venue, booking, booker) {
    return layout({
      title: `New booking request for ${venue.name} - FIRA`,
      preheader: `${booker.name} wants to book ${venue.name}`,
      heading: 'New booking request 🎉',
      body: [
        hey(ownerName),
        paragraph(`<strong style="color: #ffffff;">${esc(booker.name)}</strong> wants to book <strong style="color: ${VIOLET};">${esc(venue.name)}</strong>.`),
        detailsCard([
          ['Date', booking.date ? longDate(booking.date) : ''],
          ['Time', booking.startTime && booking.endTime ? `${esc(booking.startTime)} - ${esc(booking.endTime)}` : ''],
          ['Guests', booking.guestCount ? esc(booking.guestCount) : ''],
          ['Guest', esc(booker.name)],
          ['Total', booking.totalPrice ? formatInr(booking.totalPrice) : '', true],
        ]),
        paragraph("Accept or decline it in your venue portal. Once you accept, the guest pays to confirm; if they don't, the dates are freed."),
      ].join(''),
      cta: { label: 'Review request', url: clientUrl('/venue-portal/bookings') },
    });
  },

  /** To the venue owner: an organiser wants to hold an event at their venue. */
  eventRequestNotification(ownerName, venue, event, organizer) {
    const start = event.startDateTime ? new Date(event.startDateTime) : null;
    const end = event.endDateTime ? new Date(event.endDateTime) : null;
    return layout({
      title: `New event request for ${venue.name} - FIRA`,
      preheader: `${organizer.name} wants to host ${event.name} at ${venue.name}`,
      heading: 'New event request 🎉',
      body: [
        hey(ownerName),
        paragraph(`<strong style="color: #ffffff;">${esc(organizer.name)}</strong> wants to host an event at <strong style="color: ${VIOLET};">${esc(venue.name)}</strong>.`),
        detailsCard([
          ['Starts', start ? dateTime(start) : ''],
          ['Ends', end ? dateTime(end) : ''],
          ['Category', esc(event.category)],
          ['Expected guests', event.maxAttendees ? esc(event.maxAttendees) : ''],
          ['Organiser', esc(organizer.name)],
        ], { title: event.name }),
        paragraph('If you approve, the organiser pays your venue price in full before the event goes live.'),
      ].join(''),
      cta: { label: 'Review request', url: clientUrl('/venue-portal/events') },
    });
  },

  /** A short booking update to the guest: accepted - pay to confirm, booking tomorrow, and the like. */
  bookingUpdate(name, { heading, lines = [], link, linkText = 'View booking' }) {
    return layout({
      title: `${heading} - FIRA`,
      preheader: lines[0] || heading,
      heading: esc(heading),
      body: [hey(name), ...lines.map(line => paragraph(esc(line)))].join(''),
      cta: link ? { label: linkText, url: link } : undefined,
    });
  },

  /** Balance reminder for an installment booking. */
  balanceReminder(name, { venueName, daysLeft, balanceAmount, balanceDueAt, bookingId }) {
    const dayLabel = daysLeft === 1 ? 'day' : 'days';
    return layout({
      title: 'Balance payment due - FIRA',
      preheader: `${formatInr(balanceAmount)} due in ${daysLeft} ${dayLabel} for ${venueName}`,
      heading: `⏳ ${esc(daysLeft)} ${dayLabel} left to pay`,
      body: [
        hey(name),
        paragraph(`A friendly reminder to pay the rest for your booking at <strong style="color: ${VIOLET};">${esc(venueName)}</strong>.`),
        detailsCard([
          ['Venue', esc(venueName)],
          ['Balance due', formatInr(balanceAmount), true],
          ['Pay by', longDate(balanceDueAt)],
        ]),
        noteBox(["If the balance isn't paid by then, the booking is cancelled automatically and the advance is not refunded."], { tone: 'warn' }),
      ].join(''),
      cta: { label: 'Pay now', url: clientUrl(bookingId ? `/dashboard/bookings/${bookingId}` : '/dashboard/bookings') },
    });
  },

  /** Final notice, 2 days before: pay the balance or cancel. */
  balanceFinalNotice(name, { venueName, balanceAmount, balanceDueAt, bookingId }) {
    const due = dateTime(balanceDueAt);
    return layout({
      title: 'Final notice: pay or cancel - FIRA',
      preheader: `Pay ${formatInr(balanceAmount)} by ${due} to keep your booking`,
      heading: 'Your booking needs action',
      body: [
        hey(name),
        paragraph(`The remaining <strong style="color: #ffffff;">${formatInr(balanceAmount)}</strong> for your booking at <strong style="color: ${VIOLET};">${esc(venueName)}</strong> is still unpaid.`),
        detailsCard([
          ['Venue', esc(venueName)],
          ['Balance due', formatInr(balanceAmount), true],
          ['Pay by', due],
        ]),
        paragraph("If you can't make it, cancel before then - you get back what the venue's cancellation policy allows."),
        noteBox([`If it's neither paid nor cancelled by ${due}, the booking is cancelled automatically and the advance is not refunded.`], { tone: 'warn' }),
      ].join(''),
      cta: { label: 'Pay or cancel', url: clientUrl(`/dashboard/bookings/${bookingId}`) },
    });
  },

  /** The balance was not paid: booking cancelled, advance kept. */
  balanceForfeit(name, { venueName, depositAmount }) {
    return layout({
      title: 'Booking cancelled - FIRA',
      preheader: `Your booking at ${venueName} was cancelled`,
      heading: 'Your booking was cancelled',
      body: [
        hey(name),
        paragraph(`Your booking at <strong style="color: ${VIOLET};">${esc(venueName)}</strong> was cancelled automatically because the rest of the payment wasn't made by the deadline.`),
        detailsCard([
          ['Venue', esc(venueName)],
          ['Advance kept', `<span style="color: #ef4444;">${formatInr(depositAmount)}</span>`],
        ]),
        paragraph("Under the payment schedule, the 10% advance isn't refunded when the balance is missed. The date is now open for other guests."),
      ].join(''),
      cta: { label: 'Browse venues', url: clientUrl('/venues') },
    });
  },
};

module.exports = emailTemplates;
