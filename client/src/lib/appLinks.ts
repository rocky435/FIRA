/**
 * App-link verification files: what lets letsfira.com links open in the FIRA app.
 *
 * Android fetches /.well-known/assetlinks.json and iOS fetches
 * /.well-known/apple-app-site-association (no extension). Both must answer
 * 200 with Content-Type application/json and no redirect.
 *
 * ponytail: these are served by route handlers under /app-links/* plus a
 * rewrite in next.config.ts, not as files in public/.well-known. Amplify drops
 * dot-folders from public/ when it deploys, so the static files 404'd in
 * production even though they worked locally.
 */

export const ANDROID_PACKAGE = 'com.app.firaapp';

/**
 * SHA-256 of the certificate that signs the installed app. With Play App
 * Signing this is the "App signing key" from Play Console > Setup > App
 * integrity, not the upload key. Add a second entry to keep a debug or
 * sideloaded build verifying too.
 */
export const ANDROID_SHA256_FINGERPRINTS = [
  '8E:8A:77:64:65:70:AD:7D:BB:53:88:F1:6A:5D:2C:D7:8E:A2:6D:E5:BA:95:16:5A:AF:58:09:FB:5C:57:92:B3',
];

/** Apple Team ID + bundle id. */
export const IOS_APP_ID = '93L6J7LQUN.com.app.firaapp';

/** Website paths the iOS app claims. Android's are set by the app's intent filters. */
export const APP_LINK_PATHS = ['/events/*', '/venues/*', '/dashboard/bookings/*'];

export const assetLinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: ANDROID_SHA256_FINGERPRINTS,
    },
  },
];

export const appleAppSiteAssociation = {
  applinks: {
    apps: [],
    details: [
      {
        // `paths` is read by iOS 12 and older, `components` by iOS 13+.
        appID: IOS_APP_ID,
        appIDs: [IOS_APP_ID],
        paths: APP_LINK_PATHS,
        components: APP_LINK_PATHS.map(p => ({ '/': p })),
      },
    ],
  },
};

export function appLinkJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Short cache so a changed fingerprint or app id takes effect quickly.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
