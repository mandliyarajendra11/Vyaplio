/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  module._compile(outputText, filename);
};
const { verifyAdmin } = require('../src/lib/server/admin.ts');

const request = (token) => new Request('http://localhost/api/admin/shops', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const service = (user, allowed, mustChange = false) => ({
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: allowed ? { user_id: user?.id, must_change_password: mustChange } : null, error: null }) }) }) }),
});

test('admin access requires a valid bearer token and a server-side admin role', async () => {
  const missing = await verifyAdmin(service({ id: 'owner' }, true), request());
  assert.equal(missing.error.status, 401);
  const invalid = await verifyAdmin(service(null, false), request('bad-token'));
  assert.equal(invalid.error.status, 401);
  const shopkeeper = await verifyAdmin(service({ id: 'shopkeeper' }, false), request('valid-token'));
  assert.equal(shopkeeper.error.status, 403);
  const pending = await verifyAdmin(service({ id: 'new-admin' }, true, true), request('valid-token'));
  assert.equal(pending.error.status, 428);
  const admin = await verifyAdmin(service({ id: 'admin-id' }, true), request('valid-token'));
  assert.equal(admin.adminId, 'admin-id');
});
