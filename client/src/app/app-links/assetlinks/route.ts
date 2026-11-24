// Served at /.well-known/assetlinks.json via a rewrite in next.config.ts.
import { assetLinks, appLinkJsonResponse } from '@/lib/appLinks';

export const dynamic = 'force-static';

export function GET() {
  return appLinkJsonResponse(assetLinks);
}
