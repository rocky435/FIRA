// Served at /.well-known/apple-app-site-association via a rewrite in next.config.ts.
import { appleAppSiteAssociation, appLinkJsonResponse } from '@/lib/appLinks';

export const dynamic = 'force-static';

export function GET() {
  return appLinkJsonResponse(appleAppSiteAssociation);
}
