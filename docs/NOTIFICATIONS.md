# FIRA notifications and emails

Every message FIRA sends, who gets it, and what it opens. The wording lives in
the backend, so a change made there shows everywhere at once: the website's
notification list, browser push and the mobile app (FCM).

To change any wording, mark it up here and hand it back; the code places are
listed at the end of each section.

**House style:** titles in sentence case, no full stop, ` - ` between two
parts ("Booking cancelled - not paid"). Emoji only for good news (🎉 🎟️).

## Notifications (app, website and push)

### Guests booking a venue

| When | Title | Opens |
|---|---|---|
| The venue accepts the request | Booking accepted - pay to confirm | The booking |
| The guest has paid | Booking confirmed 🎉 | The booking |
| The venue declines the request | Booking declined | The booking |
| The venue didn't answer in time | Booking request expired | The booking |
| Accepted but not paid by the deadline | Booking cancelled - not paid | The booking |
| 10% advance paid, the rest is due | Balance payment due | The booking |
| Two days before the balance deadline | Final notice: pay or cancel | The booking |
| The balance was never paid | Booking cancelled - deposit forfeited | Bookings |
| The day before the booking | Your booking is tomorrow | The booking |
| The guest cancels, or the venue is removed | Booking cancelled | Bookings |

### Venue owners

| When | Title | Opens |
|---|---|---|
| A guest asks to book | New booking request | That request (venue portal) |
| A guest pays the advance or in full | New booking request - advance paid / Booking confirmed - guest paid | The booking (venue portal) |
| A request expires, or isn't paid in time | Booking request expired / Booking cancelled - not paid | The booking (venue portal) |
| A guest cancels | Booking cancelled | The booking (venue portal) |
| FIRA records or reverses a payout | Settlement recorded for *venue* / Settlement reversed for *venue* | Earnings |
| Someone sends an enquiry | New enquiry for *venue* | The venue |

### Event organisers

| When | Title | Opens |
|---|---|---|
| The venue approves the event | The venue approved your event (with the amount to pay and the deadline) | The venue payment page |
| The venue declines the event | The venue declined your event | - |
| FIRA approves or rejects the event | Your event was approved / Your event was not approved | - |
| The venue is paid and the event is approved | Your event is live | - |
| The venue wasn't paid in time | Event cancelled - venue not paid | - |
| Someone buys a ticket | Ticket sold | The event dashboard |
| FIRA records or reverses a payout | Settlement recorded for *event* / Settlement reversed for *event* | Earnings |

### Ticket buyers

| When | Title | Opens |
|---|---|---|
| A ticket is bought | Ticket confirmed 🎟️ | My tickets |
| One hour before the event | Your event starts in 1 hour | The event |
| The ticket is cancelled | Ticket cancelled | - |
| The organiser cancels the event | Event cancelled - refund requested | - |
| FIRA pays or refuses a refund | Refund sent / Refund not approved | - |

### Everyone

| When | Title | Opens |
|---|---|---|
| Government ID or PAN reviewed | Your government ID is verified / Your PAN was not accepted (and so on) | Settings |
| Someone follows your brand | New follower | Your page |
| A brand you follow posts or announces an event | New post from *brand* / New event from *brand* | The brand / the event |
| An event you're going to posts an update | New update from *event* | The event |
| A venue or organiser replies to your enquiry | You got a reply to your enquiry about *listing* | Messages |
| Turning notifications on, or the test button | FIRA notifications are on 🎉 | Notifications |

Code: the `title:` lines in `server/services/*.js` and `server/jobs/scheduledJobs.js`.

## Emails

All emails share one design: the violet **FIRA / Let's Celebrate** header, a
dark body, one button, and the same footer with the support address
(`SUPPORT_EMAIL` in the server `.env`, default `support@fira.com`).

| Email | Sent to | When |
|---|---|---|
| *1234* is your FIRA verification code | New user | Signing up |
| Welcome to FIRA! 🎉 | New user | Email verified |
| *1234* - Reset your FIRA password | User | Forgot password |
| Your FIRA password was changed | User | Password changed |
| Your FIRA payout account was changed | Owner / organiser | Bank details changed |
| Your Ticket for *event* 🎟️ (with the QR code to scan at the door) | Buyer | Ticket bought |
| ⏰ *event* starts in 1 hour! | Buyer | One hour before |
| New Booking Request for *venue* 🎉 | Venue owner | A guest asks to book |
| New Event Request for *venue* 🎉 | Venue owner | An organiser asks to host an event |
| Booking updates (accepted - pay to confirm, booking tomorrow, and so on) | Guest | As the booking moves along |
| ⏳ Balance due in *n* days for *venue* | Guest | Balance reminders |
| Final notice: pay ₹*n* or cancel your booking at *venue* | Guest | Two days before the balance deadline |
| Your booking at *venue* was cancelled | Guest | Balance never paid |

Followers are **not** emailed when a brand posts or announces an event: one
email per follower per post would use up the mail provider's sending limit.
They get the app notification and push instead. (The two email designs are
kept, so it can be switched back on per call in `notifyBrandFollowers`.)

Code: designs in `server/utils/emailTemplates.js`, subjects in
`server/services/emailService.js`.

## For the mobile app

Each push carries `title`, `body`, `data.link` (the screen to open, as in the
"Opens" column) and `data.type`. See `docs/flutter-push/README.md`.
