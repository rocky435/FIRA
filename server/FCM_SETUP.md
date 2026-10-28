# Native app push notifications (FCM)

The FIRA Flutter app gets push notifications through **Firebase Cloud Messaging
(FCM)**. The website keeps using **Web Push + VAPID**. Both run side by side:
every notification that pushes today goes to the user's browsers (Web Push)
and to their app installs (FCM).

Browser Web Push subscriptions and VAPID keys only work in browsers and PWAs,
through Service Workers. A native Android app has no browser subscription.
FCM device tokens are its equivalent, so the two systems store their own
records and send separately.

## What sends a push

There is no new trigger list: FCM is added at the two points where Web Push was
already sent, so the app receives exactly what browsers receive.

| Source | Where | Examples |
|---|---|---|
| Notifications with channel `push`/`all` | `services/notificationService.js` (`dispatchPush`) | booking request/accepted/rejected, payment reminders, payment success, tickets, event updates and cancellations, refunds, settlements, new events from followed brands |
| Chat messages | `routes/message.js` (`fanOutMessage`) | new message in a conversation (to the other participants only) |

`in_app` notifications stay silent, as before.

## Backend setup

0. The server needs **Node.js 22 or newer** (firebase-admin 14). Check with `node -v` on the server.
1. Firebase console → create or open the project → **Project settings → Service accounts → Generate new private key**. A JSON file downloads.
2. Give it to the server with **one** of these:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON=<the JSON on one line, or base64 of the file>
   FIREBASE_SERVICE_ACCOUNT_PATH=/home/fira/secrets/firebase-service-account.json
   GOOGLE_APPLICATION_CREDENTIALS=/home/fira/secrets/firebase-service-account.json
   ```
   Base64 on Linux: `base64 -w0 firebase-service-account.json`.
   Keep the file out of git, and readable only by the server user (`chmod 600`).
3. Restart. The log shows `✅ FCM configured` on the first send. Without
   credentials the server runs normally and logs `FCM disabled`. Web Push is
   unaffected either way.

Firebase credentials are not in this repo. Until they are set, app push is off.

## API (for the Flutter app)

Base URL: `https://api.letsfira.com/api` (`/api/v1/...` also works). All
calls send `Authorization: Bearer <login token>`. Do not send browser cookies
from the app: with cookies, the website's CSRF check applies.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/notifications/fcm/register` | `{ "fid" or "token", "platform": "android"\|"ios", "deviceId"?, "appVersion"?, "previousToken"? }` | `201 { success, pushEnabled }` |
| POST | `/notifications/fcm/unregister` | `{ "fid" }` or `{ "token" }` | `200 { success, removed }` |
| POST | `/notifications/fcm/test` | none | `200 { sent }`, `404` if no device, `503` if Firebase is not configured |

`fid` is the Firebase Installation ID from firebase_messaging 17+
(`register()` / `onRegistered`), which is the current API. `token` is the
classic registration token from `getToken()`, deprecated in firebase_messaging
17. The server accepts and sends to both. A ready-made app class that uses the
`fid` API is in `docs/flutter-push/`.

How the server handles tokens (and fids):

- **Re-registering is safe.** The same token is stored once; registering it again just refreshes it.
- **Shared devices.** If another user signs in on the same device, the token moves to that user.
- **Token refresh.** Pass `previousToken`, or send the same `deviceId` every time, and the old token is deleted.
- **Device limit.** A user keeps up to 10 devices; the least recently used one is dropped.
- **Unregistering** removes only the caller's own token.
- **Dead tokens.** Tokens FCM reports as unregistered or invalid are deleted automatically when a send fails.

### Message format

```json
{
  "notification": { "title": "Booking accepted", "body": "Pay the advance to confirm..." },
  "data": {
    "type": "booking_accepted",
    "link": "/dashboard/bookings/<id>",
    "referenceId": "<id>",
    "title": "...", "body": "...",
    "conversationId": "<id, chat only>"
  },
  "android": { "priority": "high", "notification": { "channelId": "fira_default" } }
}
```

All `data` values are strings. `link` is the website path for the same
screen; map it to an app route. `type` is the notification type (`message`
for chat, `test` for the test endpoint).

## Database

New collection **`devicetokens`** (`models/DeviceToken.js`): `user`, `token`
(unique - the token or fid value), `kind` (`token`|`fid`), `platform`, `deviceId`, `appVersion`, `lastUsedAt`, timestamps.
Deleting an account deletes its tokens. The existing `pushsubscriptions`
collection (Web Push) is unchanged.

## Flutter side (to do in the app)

The full step-by-step guide and code, checked with `flutter analyze` and built into a debug APK, is in
**`docs/flutter-push/README.md`**. In short: `flutterfire configure`, add
firebase_core + firebase_messaging + flutter_local_notifications + http +
shared_preferences, enable core library desugaring, add the manifest
permission/channel, copy `push_notifications.dart`, call `init()` at startup,
`registerDevice()` after sign-in, and `unregisterDevice()` before logout.

iOS also needs an **APNs key uploaded to Firebase** (Project settings → Cloud Messaging) and
the Push Notifications + Background Modes capabilities in Xcode; see Step 4b of that README.
The server needs no iOS-specific settings: the same service account sends to both.

## Testing checklist

| Check | How |
|---|---|
| App gets a token | log `getToken()` after sign-in |
| Token saved | `db.devicetokens.find({ user: ObjectId("...") })` |
| Delivery | `POST /api/notifications/fcm/test` with the app's login token |
| Foreground / background / closed | send the test with the app in each state; tap opens the right screen |
| Refresh | reinstall or clear data, sign in: still one row per device |
| Logout | after logout the row is gone and the test returns 404 |
| Real triggers | accept a booking request, send a chat message: the app gets both |
| Web Push still works | website → Notifications → enable → send test |
