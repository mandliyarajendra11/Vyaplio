/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Cloud sync, recovery on a second phone and backup files, against a fake Supabase (tests/mock-supabase.cjs)
// driven by the real @supabase/supabase-js client and the real supabase/schema.sql columns.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { createMock } = require('./mock-supabase.cjs');
globalThis.WebSocket ??= class {}; // realtime is unused; Node < 22 has no WebSocket

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};

const mock = createMock();
let mods;
before(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  mods = {
    ...require('../src/lib/db.ts'),
    ...require('../src/lib/ops.ts'),
    ...require('../src/lib/auth.ts'),
    ...require('../src/lib/cloud.ts'),
    ...require('../src/lib/sync.ts'),
    ...require('../src/lib/backup.ts'),
    prefs: require('../src/lib/prefs.ts'),
    sb: require('../src/lib/supabase/client.ts'),
  };
});
after(() => mock.close());

const EMAIL = 'owner@shop.test';
const PASS = 'secret123';
const S = {}; // shared between tests (they run in order)

const norm = (d) => {
  const x = JSON.parse(JSON.stringify(d));
  delete x.shop.ownerId;
  return x;
};
const outboxTables = async () => (await mods.db.outbox.toArray()).map((o) => o.table);
const newPhone = async () => {
  await mods.sb.getSupabase().auth.signOut({ scope: 'local' });
  mods.prefs.setSession(null);
  await mods.db.delete();
  await mods.db.open();
};

test('link uploads the shop; only rows the server confirmed leave the queue; retries never duplicate', async () => {
  const { db } = mods;
  const user = await mods.register('local@phone.test', 'local123');
  const now = Date.now();
  const shop = { id: crypto.randomUUID(), ownerId: user.id, name: 'गुप्ता स्टोर', ownerName: 'राजेश', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now };
  await db.transaction('rw', [db.shops, db.outbox], async () => {
    await db.shops.add(shop);
    await mods.enqueue('shops', 'upsert', shop.id, shop);
  });
  const sugar = await mods.saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 20, sellPrice: 45, buyPrice: 40, lowStockAt: 5 });
  const maggi = await mods.saveProduct(shop.id, { nameHi: 'मैगी', nameEn: 'Maggi', unit: 'pcs', qty: 50, sellPrice: 14, buyPrice: 12, lowStockAt: 10 });
  const sale = await mods.recordSale({ shopId: shop.id, payment: 'credit', newCustomer: { name: 'रामू' }, lines: [{ product: sugar, qty: 2.5 }, { product: maggi, qty: 4 }] });
  await mods.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 1, qty: 1 }], reason: 'वापस', refundMethod: 'credit' });
  await mods.addLedger(shop.id, sale.customerId, 'credit', 50, 'नकद मिला');
  await mods.adjustStock(maggi.id, 6);
  await mods.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: await db.products.get(sugar.id), qty: 1 }] });
  Object.assign(S, { shopId: shop.id, sugar: sugar.id, maggi: maggi.id, cust: sale.customerId, saleId: sale.id });

  // Without a cloud account nothing is sent and nothing is lost.
  let r = await mods.syncNow();
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'notLinked');
  const queued = await db.outbox.count();
  assert.ok(queued > 10);

  await mods.cloudSignUp(EMAIL, PASS);
  // 1) The server is down for sales: everything before sales is confirmed, the rest stays queued.
  mock.faults.push({ table: 'sales', status: 503, message: 'Service Unavailable', times: 1 });
  await assert.rejects(mods.linkShop(await db.shops.get(shop.id), user.id), (e) => e.code === 'server');
  let left = await outboxTables();
  assert.ok(!left.includes('shops') && !left.includes('products') && !left.includes('customers'), 'confirmed tables left the queue');
  assert.ok(left.includes('sales') && left.includes('credit_ledger') && left.includes('stock_moves'));
  assert.equal(mock.rows('sales').length, 0);
  let status = await mods.getSyncStatus();
  assert.equal(status.ok, false);
  assert.equal(status.error.code, 'server', 'real error is recorded for the UI');

  // 2) Sales are committed but the answer is lost: still queued; the retry upserts the same ids.
  mock.faults.push({ table: 'sales', status: 503, afterCommit: true, times: 1 });
  r = await mods.syncNow();
  assert.equal(r.error.code, 'server');
  assert.equal(mock.rows('sales').length, 2, 'server committed');
  assert.ok((await outboxTables()).includes('sales'), 'but the phone never got the confirmation');
  // 3) The server applies a batch but confirms only part of it.
  mock.faults.push({ table: 'credit_ledger', confirmOnly: 0, times: 1 });
  mock.faults.push({ table: 'stock_moves', status: 500, message: 'boom', times: 1 });
  r = await mods.syncNow();
  assert.equal(r.error.code, 'server');
  left = await outboxTables();
  assert.ok(!left.includes('sales'), 'sales retry confirmed');
  assert.ok(!left.includes('credit_ledger'), 'ledger rows that already existed are confirmed by a read-back');
  assert.ok(left.includes('stock_moves'), 'unconfirmed rows stay queued');
  assert.equal(r.pending, await db.outbox.count(), 'pending count is honest');

  // 4) Everything goes through; nothing duplicated.
  r = await mods.syncNow();
  assert.equal(r.error, undefined);
  assert.equal(await db.outbox.count(), 0);
  for (const [remote, local] of [['products', 'products'], ['customers', 'customers'], ['sales', 'sales'], ['credit_ledger', 'ledger'], ['sale_corrections', 'corrections'], ['stock_moves', 'stockMoves']])
    assert.equal(mock.rows(remote).length, await db.table(local).count(), `${remote}: one server row per local row`);
  assert.equal(mock.rows('sale_items').length, 3, 'sale_items mirrored from sales.items');
  status = await mods.getSyncStatus();
  assert.equal(status.ok, true);

  // A retried correction is accepted (insert-only, on conflict do nothing) ...
  const corr = (await db.corrections.toArray())[0];
  await mods.enqueue('sale_corrections', 'upsert', corr.id, corr);
  r = await mods.syncNow();
  assert.equal(r.error, undefined);
  assert.equal(await db.outbox.count(), 0);
  assert.equal(mock.rows('sale_corrections').length, 1);
  // ... while an update of history is refused by the insert-only policy (what the old sync did).
  const res = await mods.sb.getSupabase().from('sale_corrections').upsert([require('../src/lib/syncSchema.ts').toRemote('sale_corrections', corr, 'x')]);
  assert.equal(res.error.code, '42501');
});

test('second phone: sign in and pull reproduces stock, udhaar and bills exactly', async () => {
  const before = norm(await mods.collectShop(S.shopId));
  S.before = before;
  await newPhone();
  assert.equal(await mods.db.shops.count(), 0);
  const shop = await mods.recoverFromCloud(EMAIL, PASS);
  assert.equal(shop.id, S.shopId);
  const afterData = norm(await mods.collectShop(S.shopId));
  assert.deepEqual(afterData, before);
  const p = await mods.db.products.get(S.maggi);
  assert.equal(p.qty, 50 - 4 + 1 + 6);
  assert.equal((await mods.db.customers.get(S.cust)).balance, 2.5 * 45 + 4 * 14 - 14 - 50);
  assert.equal((await mods.db.sales.get(S.saleId)).status, 'partially_returned');
  // The local account works offline afterwards with the same password.
  mods.prefs.setSession(null);
  await mods.login(EMAIL, PASS);
  assert.equal(mods.prefs.getSession(), shop.ownerId);
});

test('incremental pull: two phones selling at once add up; edits are last-write-wins', async () => {
  const { db } = mods;
  const { createClient } = require('@supabase/supabase-js');
  const other = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, 'test-anon-key', { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: EMAIL, password: PASS });
  const { toRemote } = require('../src/lib/syncSchema.ts');
  const uid = (await other.auth.getSession()).data.session.user.id;
  const t = Date.now();
  // Phone A (offline until now): sold 3 maggi on udhaar to the same customer, changed sugar's price.
  const maggi = await db.products.get(S.maggi);
  const sugar = await db.products.get(S.sugar);
  const cust = await db.customers.get(S.cust);
  const saleA = { id: crypto.randomUUID(), shopId: S.shopId, items: [{ productId: maggi.id, nameHi: 'मैगी', nameEn: 'Maggi', unit: 'pcs', qty: 3, price: 14, cost: 12 }], total: 42, cost: 36, payment: 'credit', customerId: cust.id, createdAt: t, day: '2026-10-22' };
  assert.equal((await other.from('sales').upsert([toRemote('sales', saleA, uid)]).select('id')).error, null);
  assert.equal((await other.from('stock_moves').insert([toRemote('stock_moves', { id: crypto.randomUUID(), shopId: S.shopId, productId: maggi.id, delta: -3, reason: 'sale', refId: saleA.id, createdAt: t }, uid)])).error, null);
  assert.equal((await other.from('credit_ledger').insert([toRemote('credit_ledger', { id: crypto.randomUUID(), shopId: S.shopId, customerId: cust.id, type: 'debit', amount: 42, saleId: saleA.id, createdAt: t }, uid)])).error, null);
  assert.equal((await other.from('products').upsert([toRemote('products', { ...sugar, sellPrice: 48, updatedAt: t + 5000 }, uid)])).error, null);
  // ... and an OLD rename of the customer arrives late: the server keeps the newer row.
  assert.equal((await other.from('customers').upsert([toRemote('customers', { ...cust, name: 'पुराना नाम', updatedAt: cust.updatedAt - 1000 }, uid)])).error, null);

  // Phone B (this one) sells 2 maggi at the same time.
  await mods.recordSale({ shopId: S.shopId, payment: 'cash', lines: [{ product: maggi, qty: 2 }] });
  const r = await mods.syncNow();
  assert.equal(r.error, undefined);
  assert.equal((await db.products.get(S.maggi)).qty, maggi.qty - 3 - 2, 'stock = sum of both phones');
  assert.equal((await db.customers.get(S.cust)).balance, cust.balance + 42, 'udhaar includes the other phone');
  assert.equal((await db.customers.get(S.cust)).name, cust.name, 'older edit lost (last write wins)');
  assert.equal((await db.products.get(S.sugar)).sellPrice, 48, 'newer edit from the other phone applied');
  assert.ok(await db.sales.get(saleA.id), "other phone's bill pulled");
  assert.equal(await db.outbox.count(), 0);
});

test('deleting a product on one phone removes it on the other (tombstone)', async () => {
  const { db } = mods;
  await mods.deleteProduct(S.sugar);
  assert.equal((await mods.syncNow()).error, undefined);
  const row = mock.rows('products').find((p) => p.id === S.sugar);
  assert.ok(row.deleted_at, 'server keeps a tombstone');
  const snap = norm(await mods.collectShop(S.shopId));
  await newPhone();
  await mods.recoverFromCloud(EMAIL, PASS);
  assert.equal(await db.products.get(S.sugar), undefined);
  assert.deepEqual(norm(await mods.collectShop(S.shopId)), snap);
});

test('discount allocation survives recovery on another phone and refunds only the paid value', async () => {
  const product = await mods.db.products.get(S.maggi);
  const sale = await mods.recordSale({ shopId: S.shopId, payment: 'cash', lines: [{ product, qty: 3, discount: { kind: 'amount', value: 3 } }], discount: { kind: 'amount', value: 1 } });
  assert.equal(sale.total, 38);
  assert.equal((await mods.syncNow()).error, undefined);
  assert.equal(mock.rows('sales').find(s => s.id === sale.id).items[0].discount, 4);
  assert.equal(mock.rows('sales').find(s => s.id === sale.id).items[0].itemDiscount, 3);
  await newPhone();
  await mods.recoverFromCloud(EMAIL, PASS);
  assert.equal((await mods.db.sales.get(sale.id)).items[0].discount, 4);
  assert.equal((await mods.db.sales.get(sale.id)).items[0].itemDiscount, 3);
  const returned = await mods.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'Return on second phone', refundMethod: 'cash' });
  assert.equal(returned.amount, 12.67);
  assert.equal((await mods.syncNow()).error, undefined);
  await newPhone();
  await mods.recoverFromCloud(EMAIL, PASS);
  const rest = await mods.correctSale({ saleId: sale.id, type: 'cancel', reason: 'Cancel remainder', refundMethod: 'cash' });
  assert.equal(rest.amount, 25.33);
  assert.equal((await mods.syncNow()).error, undefined);
});

test('rounded bill keeps exact paid and refund values after recovery on another phone', async () => {
  const product = await mods.saveProduct(S.shopId, { nameHi: 'राउंड सामान', nameEn: 'Round Item', unit: 'pcs', qty: 5, sellPrice: 10.49, buyPrice: 4, lowStockAt: 1 });
  const sale = await mods.recordSale({ shopId: S.shopId, payment: 'cash', roundToRupee: true, lines: [{ product, qty: 2 }] });
  assert.equal(sale.total, 21);
  assert.equal(sale.items[0].rounding, 0.02);
  assert.equal((await mods.syncNow()).error, undefined);
  assert.equal(mock.rows('sales').find(s => s.id === sale.id).items[0].rounding, 0.02);
  await newPhone();
  await mods.recoverFromCloud(EMAIL, PASS);
  const back = await mods.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'One returned', refundMethod: 'cash' });
  assert.equal(back.amount, 10.5);
  assert.equal((await mods.syncNow()).error, undefined);
  await newPhone();
  await mods.recoverFromCloud(EMAIL, PASS);
  const rest = await mods.correctSale({ saleId: sale.id, type: 'cancel', reason: 'Remainder', refundMethod: 'cash' });
  assert.equal(rest.amount, 10.5);
});

test('backup file round-trip (plain + password), corrupt files are refused and change nothing', async () => {
  const { db } = mods;
  const original = norm(await mods.collectShop(S.shopId));
  const plain = await mods.createBackup(S.shopId);
  const locked = await mods.createBackup(S.shopId, 'मेरा-पासवर्ड');
  assert.ok(!locked.text.includes('मैगी') && !locked.text.includes(S.shopId), 'locked file hides the data');

  const code = (c) => (e) => e instanceof mods.BackupError && e.code === c;
  await assert.rejects(mods.readBackup(locked.text), code('needPassword'));
  await assert.rejects(mods.readBackup(locked.text, 'wrong'), code('wrongPassword'));
  await assert.rejects(mods.readBackup(plain.text.slice(0, 200)), code('notJson'));
  await assert.rejects(mods.readBackup('{"hello":1}'), code('notBackup'));
  const tampered = JSON.parse(plain.text);
  tampered.data.products[0].qty = 9999;
  await assert.rejects(mods.readBackup(JSON.stringify(tampered)), code('checksum'));
  // A file that is internally broken but has a matching checksum is still refused.
  const broken = JSON.parse(plain.text);
  broken.data.ledger[0].customerId = 'nobody';
  const crypto = require('node:crypto');
  broken.checksum = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(broken.data)).digest('hex');
  await assert.rejects(mods.readBackup(JSON.stringify(broken)), (e) => e.code === 'invalid' && /ledger\[0\]\.customerId/.test(e.detail));
  assert.deepEqual(norm(await mods.collectShop(S.shopId)), original, 'refused files changed nothing');

  const { data, preview } = await mods.readBackup(locked.text, 'मेरा-पासवर्ड');
  assert.equal(preview.shopName, 'गुप्ता स्टोर');
  assert.equal(preview.encrypted, true);
  assert.equal(preview.bills, original.sales.length);
  assert.deepEqual(preview.warnings, []);

  // New phone without cloud: create a local account, restore the file.
  await newPhone();
  const u = await mods.register('fresh@phone.test', 'fresh123');
  await mods.restoreBackup(data, u.id);
  assert.deepEqual(norm(await mods.collectShop(S.shopId)), original);
  assert.equal((await db.shops.get(S.shopId)).ownerId, u.id);
  assert.equal(await db.outbox.count(), 0, 'not linked: nothing queued');

  // Restoring over an existing different shop replaces it (never merges).
  const now = Date.now();
  await db.shops.put({ id: 'other-shop', ownerId: u.id, name: 'X', ownerName: '', language: 'en', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now });
  await mods.saveProduct('other-shop', { nameHi: 'x', nameEn: 'x', unit: 'pcs', qty: 1, sellPrice: 1, buyPrice: 1, lowStockAt: 0 });
  const again = await mods.readBackup(plain.text);
  await mods.restoreBackup(again.data, u.id, 'other-shop');
  assert.equal(await db.shops.get('other-shop'), undefined);
  assert.equal(await db.products.where('shopId').equals('other-shop').count(), 0);
  assert.deepEqual(norm(await mods.collectShop(S.shopId)), original);
});
