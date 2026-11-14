# FIRA push notifications: API for the mobile app

How the Android and iOS apps send their Firebase Cloud Messaging (FCM) token to the FIRA server, and what they receive. Base URL: `https://api.letsfira.com/api/v1` (`/api` also works). The field names, endpoints and responses below are the existing ones; `player_id` is only an extra field.

## Sending the token

Send these optional fields on **signup, verify-email, and login**:

| Field | Value | Notes |
|---|---|---|
| `player_id` | FCM registration token from `FirebaseMessaging.getToken()` | Required for push; everything else is optional |
| `device_type` | `android` or `ios` | Defaults to `android` |
| `device_id` | A stable id for this install (any string up to 200 chars) | Lets a refreshed token replace the old one instead of adding a second device |
| `app_version` | e.g. `2.3.0` | Shown to support only |

`playerId`, `deviceType`, `deviceId` and `appVersion` (camelCase) also work.

| Call | What happens to `player_id` |
|---|---|
| `POST /auth/register` and `POST /auth/register-venue-owner` | Accepted and **held** on the new, unverified account. No notifications go to it yet: the email isn't proven until the code is entered. |
| `POST /auth/verify-otp` | The account is verified, and the device is saved. A `player_id` sent here wins; otherwise the one sent at signup is used. |
| `POST /auth/login` | The device is saved, or refreshed if it's already known. |

Responses are unchanged, apart from `deviceSaved: true/false` on verify-otp and login so the app can tell whether its token was stored.

**A missing, empty or invalid `player_id` never blocks signup, verification or login.** The call succeeds and `deviceSaved` is `false`.

A user can be signed in on up to **10 devices**, and each one gets notifications. If a token is registered by a different account (someone else signs in on that phone), it moves to the new account.

## Token refresh

When `FirebaseMessaging.onTokenRefresh` fires while the user is signed in, send:

```
POST /notifications/fcm/register
Authorization: Bearer <session token>
{ "token": "<new token>", "previousToken": "<old token>", "platform": "android", "deviceId": "<install id>", "appVersion": "2.3.0" }
```

The old token is removed. You can call this after every app start; registering the same token again only refreshes it. Newer Firebase SDKs that return an installation id can send `"fid"` instead of `"token"`.

## Logout

Send `player_id` with `POST /auth/logout`, or call `POST /notifications/fcm/unregister` with `{ "token": "<token>" }` before logging out. Only this phone stops getting notifications; the user's other devices keep theirs. Signing out on the website doesn't affect the phone.

## What the app receives

Each push has a `notification` block (title and body, shown by the system) and a `data` block. Every `data` value is a string:

| `data` key | Meaning |
|---|---|
| `title`, `body` | Same as the notification block, for foreground display |
| `link` | In-app path to open on tap, e.g. `/dashboard/bookings/<id>`, `/dashboard/events/<id>`, `/events/<id>`, `/notifications` |
| `type` | What happened, e.g. `booking_accepted`, `booking_cancelled`, `ticket_purchased`, `refund_update`, `system`, `message` |
| `referenceId` | The id of the booking, event, ticket or refund it is about (when there is one) |

Tokens that Firebase reports as dead (app uninstalled, data cleared) are deleted on the server automatically.

## When a push is sent

Every notification below also appears in the in-app inbox and as a pop-up on the website.

| Who | When |
|---|---|
| **Guest** | Booking accepted, declined or cancelled; payment received; balance due, final notice, balance paid; booking forfeited; day-before reminder; ticket bought or cancelled; refund requested, sent or declined; event cancelled (paid or free ticket); event details changed; event starts in 1 hour; organiser posted an update; private-event request accepted or declined; reply to an enquiry; new chat message |
| **Organiser** | Venue approved or declined the event; admin approved or rejected it; event is live; event blocked, unblocked or removed by FIRA; event cancelled because the venue wasn't paid; ticket sold; new private-event request; PAN check result; payout settled or reversed |
| **Venue owner** | New booking request; new event request at the venue; guest paid (advance or balance); booking cancelled; event at the venue cancelled; venue approved, rejected, blocked, unblocked or removed by FIRA; government-ID check result; payout settled or reversed; new enquiry |
| **Creator** | Profile approved, rejected, blocked, unblocked or removed; new follower |
| **Followers** | A followed creator posted or announced a new event |

## Testing on a device

Sign in on the app, then call `POST /notifications/fcm/test` with the session token. It sends "FIRA notifications are on 🎉" to that user's devices. It returns 503 if the server has no Firebase credentials, and 404 if no device received it.

## Server setup (FIRA, not the app)

The Firebase project, the Android and iOS app registration, and the APNs key for iOS all live under the Google account named in the requirements. The server needs that project's service-account JSON in `FIREBASE_SERVICE_ACCOUNT_JSON` (in `server/.env`, raw JSON or base64), followed by a restart. On start-up it logs `✅ FCM configured`.
