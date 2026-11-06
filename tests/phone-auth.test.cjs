/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const nodeCrypto = require('node:crypto');
require('fake-indexeddb/auto');
globalThis.crypto ??= nodeCrypto.webcrypto;
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  module._compile(outputText, filename);
};
const { indiaPhone, phoneLocalAccount } = require('../src/lib/phone.ts');
const { db } = require('../src/lib/db.ts');
const { ensureLocalUser, ensureLocalUserAfterPhoneRecovery, login } = require('../src/lib/auth.ts');
const { cloudSendPhoneOtp } = require('../src/lib/cloud.ts');

test('Indian phone is normalized without accepting short, foreign or malformed numbers', () => {
  for (const value of ['9876543210', '+91 98765 43210', '९८७६५४३२१०']) assert.equal(indiaPhone(value), '+919876543210');
  for (const value of ['1234567890', '98765', '+1 9876543210', '9876543210abc']) assert.equal(indiaPhone(value), null);
  assert.equal(phoneLocalAccount('+919876543210'), 'phone-919876543210@local.vyaplio');
});

test('recovery OTP request cannot create an account for a malformed number', async () => {
  await assert.rejects(cloudSendPhoneOtp('1234'), (e) => e.code === 'auth' && e.detail === 'phoneInvalid');
});

test('after verified phone recovery, local account can replace forgotten offline password', async () => {
  const email = 'owner@example.com';
  const first = await ensureLocalUser(email, 'oldpass');
  const reset = await ensureLocalUserAfterPhoneRecovery(email, 'newpass');
  assert.equal(reset.id, first.id);
  await assert.rejects(login(email, 'oldpass'), /invalid/);
  assert.equal((await login(email, 'newpass')).id, first.id);
  await db.delete();
});
