# FIRA app push notifications: Flutter steps

The server side is already done; see `server/FCM_SETUP.md`. These steps cover the Android and iOS app.
The Android code here was checked with `flutter analyze` (no issues) against the versions below.
The iOS additions (Step 4b, and the `Platform.isIOS` / `DarwinInitializationSettings` /
`setForegroundNotificationPresentationOptions` lines in `push_notifications.dart`) were
**not** compiled, because the Flutter app isn't in this repo. Run `flutter analyze` after copying.

| Package | Version |
|---|---|
| firebase_core | 5.1 |
| firebase_messaging | 17.0 |
| flutter_local_notifications | 22.3 |
| http | 1.6 |
| shared_preferences | 2.5 |

## Step 1: Connect the app to Firebase (one time)

```bash
npm install -g firebase-tools        # Firebase CLI
firebase login                       # the Google account that owns the Firebase project
dart pub global activate flutterfire_cli
cd <your flutter project>
flutterfire configure --platforms=android,ios
```
Pick the **Fira** Firebase project. This does four things:
- writes `android/app/google-services.json`;
- writes `ios/Runner/GoogleService-Info.plist`;
- writes `lib/firebase_options.dart`;
- adds the Google Services Gradle plugin.

If an app isn't registered in Firebase yet, it registers it using your Android `applicationId`
and iOS bundle ID.

## Step 2: Packages

```bash
flutter pub add firebase_core firebase_messaging flutter_local_notifications http shared_preferences
```

## Step 3: Android Gradle (`android/app/build.gradle.kts`)

flutter_local_notifications needs core library desugaring and compileSdk 35 or higher:
```kotlin
android {
    compileSdk = flutter.compileSdkVersion   // must resolve to 35+; set 36 if the build complains
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true          // add
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")   // add
}
```
If your project uses `build.gradle` (Groovy), write `coreLibraryDesugaringEnabled true`
and `coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'` instead.

## Step 4: `android/app/src/main/AndroidManifest.xml`

```xml
<manifest ...>
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
    <application ...>
        <!-- background pushes use the same channel the server names -->
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_channel_id"
            android:value="fira_default" />
        ...
    </application>
</manifest>
```

## Step 4b: iOS

iOS push goes through Apple (APNs), so it needs three things Android doesn't.

1. **APNs key in Firebase** (the account owner does this once; it needs the Apple Developer account):
   - developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → `+` → tick
     **Apple Push Notifications service (APNs)** → download the `.p8` file (it can be downloaded only once).
   - Firebase console → Project settings → **Cloud Messaging** → Apple app configuration →
     **APNs Authentication Key** → upload the `.p8` with its **Key ID** and your **Team ID**.
   - Without this, iPhones receive nothing and the server logs a delivery error.
2. **Xcode** (open `ios/Runner.xcworkspace`) → Runner target → **Signing & Capabilities**:
   - `+ Capability` → **Push Notifications**;
   - `+ Capability` → **Background Modes** → tick **Remote notifications**.
3. **Pods**: `cd ios && pod install`. If it complains about the deployment target, raise
   `platform :ios` in `ios/Podfile` (and the Runner target's iOS version) to what it asks for.

No notification channel or manifest entry is needed on iOS. `registerDevice()` shows the
iOS permission prompt the first time.

## Step 5: Add the code

The two code files here end in `.dart.txt` so this repo, which isn't a Flutter project, doesn't show import errors for them. Drop the `.txt` when copying.

1. Copy `push_notifications.dart.txt` to `lib/push/push_notifications.dart` in the app.
2. Wire it into `main.dart` following `main_example.dart.txt`:
   - `Firebase.initializeApp(...)`, then `FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler)`.
   - `PushNotifications.instance.init(authToken: ..., onOpen: ...)`:
     - `authToken` returns the FIRA login token your app already stores. It's the JWT you send as `Authorization: Bearer`.
     - `onOpen` receives a website path. Map it to your screens; the table below lists the paths.
   - Give `MaterialApp` the `navigatorKey`. If you use go_router, call `router.go(...)` instead.
3. Call these in your auth code:

| When | Call |
|---|---|
| Right after a successful sign-in | `PushNotifications.instance.registerDevice();` |
| App start while already signed in | `PushNotifications.instance.registerDevice();` (already in `main_example.dart`) |
| Logout, **before** calling `/auth/logout` | `await PushNotifications.instance.unregisterDevice();` |

**Don't send cookies to the API from the app.** With cookies, the server's
website CSRF check applies and the requests fail with 403. Plain `http`, or
`dio` without a cookie manager, is fine.

### Paths the server sends in `data.link`

| Path | Screen |
|---|---|
| `/messages?conversation=<id>` | chat |
| `/dashboard/bookings/<id>` | guest's booking (accepted, pay advance or balance, reminders) |
| `/dashboard/bookings` | guest's bookings list |
| `/venue-portal/bookings/<id>` | owner's booking request |
| `/events/<id>` | event page |
| `/dashboard/events/<id>` | organiser's event dashboard |
| `/dashboard/tickets` | my tickets |
| `/venue-portal/events` | owner's event requests |
| `/messages` | enquiries and replies (they are conversations) |
| `/brands/<id>`, `/creators/<id>` | brand or creator page |
| `/notifications` | anything else |

`data.type` gives the kind, e.g. `booking_accepted`, `payment_success`,
`message` or `test`, if you want a different screen per type.

## Step 6: Test on a real phone

You need Android 13 or newer to see the permission prompt. An emulator with
Google Play also works.

| # | Test | Expected |
|---|---|---|
| 1 | Sign in | Permission prompt. Allow it. The log has no "Push: register failed". |
| 2 | Server has it | `db.devicetokens.find()` shows a row with `kind: "fid"` for your user |
| 3 | App **open**: `POST /api/notifications/fcm/test` with your login token | Notification banner appears |
| 4 | App **in background** (home button), send the test again | Notification in the tray; tapping it opens the app on `/notifications` |
| 5 | App **closed** (swipe away), send the test again | Notification in the tray; tapping it starts the app and opens the screen |
| 6 | Real trigger: send a chat message from another account on the website | Push arrives; tapping it opens the chat |
| 7 | Log out, send the test | Server answers 404 (no device); no notification |
| 8 | Sign in as a different user on the same phone | Only the new user's notifications arrive |
| 9 | Website Web Push | Still works from the website's Notifications page |

Test-call example (replace TOKEN with the app user's login JWT):
```bash
curl -X POST https://api.letsfira.com/api/notifications/fcm/test -H "Authorization: Bearer TOKEN"
```

Android limits:
- **Force stop** in Settings blocks all pushes until the app is opened again. Swiping the app away is fine.
- Some phones (Xiaomi, Oppo, Vivo, OnePlus) kill background apps. Turn off battery optimisation for FIRA when testing.

iOS: run the same tests 1–9 on a **real iPhone**; the simulator is not reliable for push.
- Test 2 shows `platform: "ios"` for the row.
- Test 3: the banner comes from iOS itself (not flutter_local_notifications), and appears once.
- Nothing arrives at all? Check Step 4b: the APNs key in Firebase, and both Xcode capabilities.
- If notifications are turned off for FIRA in iOS Settings, nothing shows; the server still answers 200.

## If the newer `fid` API gives trouble

The server also accepts classic tokens. In `push_notifications.dart`:
- use `getToken()` and `onTokenRefresh` instead of `register()` and `onRegistered`;
- send `'token'` instead of `'fid'`;
- use `deleteToken()` instead of `unregister()`.

These are deprecated in firebase_messaging 17, but they still work.

On iOS, `getToken()` fails until Apple has issued its own push token. If it throws, wait for
`await FirebaseMessaging.instance.getAPNSToken()` to return non-null, then call `getToken()`.
Try this fallback first if iOS registers no device while Android does.
