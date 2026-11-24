import { describe, it, expect } from 'vitest';
import { GET as androidGET } from '@/app/app-links/assetlinks/route';
import { GET as iosGET } from '@/app/app-links/apple-app-site-association/route';

describe('app-link verification files', () => {
  it('serves assetlinks.json as JSON for com.app.firaapp', async () => {
    const res = androidGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    expect(body[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(body[0].target.package_name).toBe('com.app.firaapp');
    expect(body[0].target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('serves apple-app-site-association as JSON for the iOS app', async () => {
    const res = iosGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const { applinks } = await res.json();
    expect(applinks.details[0].appID).toBe('93L6J7LQUN.com.app.firaapp');
    expect(applinks.details[0].paths).toEqual(['/events/*', '/venues/*', '/dashboard/bookings/*']);
  });

});
