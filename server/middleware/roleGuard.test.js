'use strict';

/**
 * roleGuard: the sub-role allow-list, its documented fallback for admins from
 * before sub-roles, and no user at all. Was a plain node script, which the
 * test runner reported as a failed file ("no test suite").
 */

const assert = require('assert');
const roleGuard = require('./roleGuard');

// Helper to build minimal req/res/next
function makeCtx(adminRole) {
  let statusCode = null;
  let body = null;
  let nextCalled = false;

  const req = { user: adminRole !== undefined ? { adminRole } : null };
  const res = {
    status(code) { statusCode = code; return res; },
    json(b) { body = b; return res; },
  };
  const next = () => { nextCalled = true; };

  return { req, res, next, result: () => ({ statusCode, body, nextCalled }) };
}

describe('roleGuard', () => {
  it('lets an allowed role through', () => {
    for (const role of ['super_admin', 'admin']) {
      const { req, res, next, result } = makeCtx(role);
      roleGuard(['super_admin', 'admin'])(req, res, next);
      assert.strictEqual(result().nextCalled, true, `${role} should pass`);
      assert.strictEqual(result().statusCode, null, 'No status should be set on pass');
    }
  });

  it('refuses a role that is not allowed', () => {
    const { req, res, next, result } = makeCtx('moderator');
    roleGuard(['super_admin', 'admin'])(req, res, next);
    assert.strictEqual(result().nextCalled, false, 'moderator should not pass');
    assert.strictEqual(result().statusCode, 403, 'Should return 403');
    assert.strictEqual(result().body.error, 'Insufficient permissions for this action');
  });

  it('lets an admin with no sub-role through (documented fallback for admins from before sub-roles)', () => {
    // Deliberate, and kept for now: changing who counts as which admin is a
    // separate decision (see routes/admin.js settlementRoleGuard).
    const { req, res, next, result } = makeCtx(null);
    roleGuard(['super_admin'])(req, res, next);
    assert.strictEqual(result().nextCalled, true);
  });

  it('refuses a request with no user at all', () => {
    let statusCode = null;
    let nextCalled = false;
    const req = {};
    const res = { status(c) { statusCode = c; return res; }, json() { return res; } };
    roleGuard(['super_admin'])(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'Missing req.user should not pass');
    assert.strictEqual(statusCode, 403);
  });
});
