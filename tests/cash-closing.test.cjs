/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Daily cash closing (आज का गल्ला): expected-cash math, close/lock, carry-forward, per-method refund caps,
// backup v3 and two-phone sync of drawer entries through the mock Supabase.
// Run: node tests/cash-closing.test.cjs
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const Dexie = require('dexie').default ?? require('dexie');
const { createTranslator } = require('use-intl/core');
const { createMock } = require('./mock-supabase.cjs');
globalThis.WebSocket ??= class {}; // realtime is unused; Node < 22 has no WebSocket

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const SRC = path.join(__dirname, '..', 'src') + path.sep;
function loadPhone() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  Dexie.dependencies.indexedDB = new IDBFactory();
  return {
    ...require('../src/lib/db.ts'),
    ...require('../src/lib/ops.ts'),
    ...require('../src/lib/payments.ts'),
    ...require('../src/lib/alerts.ts'),
    ...require('../src/lib/stats.ts'),
    ...require('../src/lib/share.ts'),
    ...require('../src/lib/auth.ts'),
    ...require('../src/lib/cloud.ts'),
    ...require('../src/lib/sync.ts'),
    ...require('../src/lib/backup.ts'),
    ...require('../src/lib/cash.ts'),
    ...require('../src/lib/dates.ts'),
  };
}
const tHi = createTranslator({ locale: 'hi', messages: JSON.parse(fs.readFileSync(path.join(SRC, 'messages', 'hi.json'), 'utf8')) });
const tEn = createTranslator({ locale: 'en', messages: JSON.parse(fs.readFileSync(path.join(SRC, 'messages', 'en.json'), 'utf8')) });

const SHOP = { name: 'शर्मा किराना', ownerName: 'रमेश', upiId: 'sharma@okbank', language: 'hi', deadStockDays: 30, expiryWarnDays: 7 };
async function makeShop(m, ownerId) {
  const now = Date.now();
  const shop = { ...SHOP, id: crypto.randomUUID(), ownerId, createdAt: now, updatedAt: now };
  await m.db.transaction('rw', [m.db.shops, m.db.outbox], async () => {
    await m.db.shops.add(shop);
    await m.enqueue('shops', 'upsert', shop.id, shop);
  });
  return shop;
}
const product = (m, shop, extra = {}) =>
  m.saveProduct(shop.id, { nameHi: 'तेल', nameEn: 'Oil', unit: 'pcs', qty: 50, sellPrice: 10, buyPrice: 8, lowStockAt: 1, ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const code = (re) => (e) => re.test(e.code);

test('expected cash: opening + cash sales (net of change) + udhaar cash − cash refunds − expenses/withdrawals; UPI kept apart', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-1');
  const oil = await product(m, shop);
  const day = m.dayKey(Date.now());
  const cust = await m.addCustomer(shop.id, 'राधा');

  // Nothing yet: opening 0, expected 0, not closed.
  let d = await m.loadCashDay(shop.id, day);
  assert.deepEqual([d.opening, d.openingSource, d.expected, d.closed], [0, 'none', 0, false]);

  await m.setOpening({ shopId: shop.id, day, amount: 500, reason: 'पहला दिन' });
  // Cash bill ₹100, customer gave ₹500 → ₹400 change; only ₹100 stays in the drawer.
  await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 10 }], payments: [{ method: 'cash', amount: 100, tendered: 500 }] });
  // Split: cash 30 + UPI 50 (received); another bill's ₹20 UPI is still pending (not counted anywhere yet).
  await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 8 }], payments: [{ method: 'cash', amount: 30 }, { method: 'upi', amount: 50, upi: 'paid' }] });
  await m.recordSale({ shopId: shop.id, payment: 'upi', lines: [{ product: oil, qty: 2 }], payments: [{ method: 'upi', amount: 20, upi: 'pending' }] });
  // Udhaar bill, then the customer pays back ₹60 cash and ₹25 UPI.
  await m.recordSale({ shopId: shop.id, payment: 'credit', lines: [{ product: oil, qty: 10 }], customerId: cust.id });
  await m.addLedger(shop.id, cust.id, 'credit', 60, 'नकद');
  await m.addLedger(shop.id, cust.id, 'credit', 25, 'gpay', 'upi');
  // Cash refund of ₹20 on the first bill reduces the drawer.
  const sales = await m.db.sales.where('shopId').equals(shop.id).sortBy('createdAt');
  await m.correctSale({ saleId: sales[0].id, type: 'return', lines: [{ index: 0, qty: 2 }], reason: 'टूटा', refundMethod: 'cash' });
  // Manual drawer entries.
  await m.addCashEntry({ shopId: shop.id, day, kind: 'expense', amount: 40, category: 'tea', note: 'चाय' });
  await m.addCashEntry({ shopId: shop.id, day, kind: 'supplier', amount: 150, supplierName: 'गुप्ता ट्रेडर्स', supplierId: 'sup-1' });
  await m.addCashEntry({ shopId: shop.id, day, kind: 'withdrawal', amount: 100 });
  await m.addCashEntry({ shopId: shop.id, day, kind: 'added', amount: 200, note: 'छुट्टा लाए' });
  await m.addCashEntry({ shopId: shop.id, day, kind: 'bank', amount: 300 });
  await assert.rejects(m.addCashEntry({ shopId: shop.id, day, kind: 'expense', amount: 10 }), code(/category/));
  await assert.rejects(m.addCashEntry({ shopId: shop.id, day, kind: 'expense', amount: -5, category: 'tea' }), code(/amount/));
  await assert.rejects(m.addCashEntry({ shopId: shop.id, day: m.dayKey(Date.now() + 2 * DAY), kind: 'added', amount: 5 }), code(/future/));

  d = await m.loadCashDay(shop.id, day);
  assert.deepEqual(d.cashIn, { sales: 130, udhaar: 60, added: 200, total: 390 });
  assert.deepEqual(d.cashOut, { refunds: 20, expense: 40, supplier: 150, withdrawal: 100, bank: 300, total: 610 });
  assert.equal(d.expected, 500 + 390 - 610); // 280
  assert.deepEqual([d.tendered, d.change], [500, 400]);
  assert.deepEqual(d.upi, { sales: 50, udhaar: 25, refunds: 0, pending: 20, net: 75 });
  assert.deepEqual(d.expensesByCategory, { tea: 40 }, 'expenses stored by category for profit-after-expenses');
  const sup = d.manual.find((e) => e.kind === 'supplier');
  assert.deepEqual([sup.supplierId, sup.supplierName], ['sup-1', 'गुप्ता ट्रेडर्स']);

  // Void (logged, needs a reason) takes the entry out of the math.
  const wd = d.manual.find((e) => e.kind === 'withdrawal');
  await assert.rejects(m.voidCashEntry({ entryId: wd.id, reason: ' ' }), code(/reason/));
  await m.voidCashEntry({ entryId: wd.id, reason: 'गलती से' });
  await assert.rejects(m.voidCashEntry({ entryId: wd.id, reason: 'again' }), code(/notFound/));
  d = await m.loadCashDay(shop.id, day);
  assert.equal(d.expected, 380);
  assert.equal(d.voided.length, 1);
  assert.equal(await m.db.cashEntries.count(), 7, 'append-only: opening + 5 entries + 1 void, nothing deleted');

  // Pure math check on the same input.
  const pure = m.computeCashDay({ day, sales: [], corrections: [], ledger: [], entries: [], carried: { day: '2026-01-01', amount: 75 } });
  assert.deepEqual([pure.opening, pure.openingSource, pure.expected], [75, 'carried', 75]);
  assert.equal(m.denomTotal({ 2000: 1, 500: 3, 200: 2, 100: 4, 50: 1, 20: 2, 10: 3, coins: 7.5 }), 2000 + 1500 + 400 + 400 + 50 + 40 + 30 + 7.5);
});

test('per-method refund caps: no UPI back beyond UPI received, no cash beyond cash; cross needs explicit tick', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-2');
  const oil = await product(m, shop);
  const day = m.dayKey(Date.now());
  // Bill: cash 30 + UPI 70.
  const s = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 10 }], payments: [{ method: 'cash', amount: 30 }, { method: 'upi', amount: 70, upi: 'paid' }] });
  assert.deepEqual(m.refundCaps(s, []), { credit: 0, cash: 30, upi: 70, upiPending: 0 });
  assert.deepEqual(m.refundMethodsFor(s, []), ['upi', 'cash'], 'larger cap offered first');
  // Return ₹50 asked as cash: ₹30 cash (all the cash received), rest UPI. Drawer never goes below what came in.
  const c1 = await m.correctSale({ saleId: s.id, type: 'return', lines: [{ index: 0, qty: 5 }], reason: 'वापस', refundMethod: 'cash' });
  assert.deepEqual(c1.refunds, [{ method: 'cash', amount: 30 }, { method: 'upi', amount: 20 }]);
  assert.equal(c1.crossMethod, undefined);
  const s1 = await m.db.sales.get(s.id);
  assert.deepEqual(m.refundCaps(s1, [c1]), { credit: 0, cash: 0, upi: 50, upiPending: 0 });
  assert.deepEqual(m.refundMethodsFor(s1, [c1]), ['upi']);
  // Cash is exhausted: a cash refund now is refused unless explicitly cross-method.
  await assert.rejects(m.correctSale({ saleId: s.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'x', refundMethod: 'cash' }), code(/method/));
  assert.equal(m.crossAmount(s1, [c1], 10, 'cash'), 10);
  const c2 = await m.correctSale({ saleId: s.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'ग्राहक को नकद चाहिए', refundMethod: 'cash', crossMethod: true });
  assert.deepEqual(c2.refunds, [{ method: 'cash', amount: 10 }]);
  assert.equal(c2.crossMethod, true);
  const d = await m.loadCashDay(shop.id, day);
  assert.deepEqual([d.cashIn.sales, d.cashOut.refunds, d.expected], [30, 40, -10], 'an explicit cross refund is the only way the drawer goes below');
  assert.deepEqual([d.upi.sales, d.upi.refunds, d.upi.net], [70, 20, 50]);
});

test('close + lock: count by notes, कम/ज़्यादा, reason for corrections, late entries flagged, void close re-opens', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-3');
  const oil = await product(m, shop);
  const day = m.dayKey(Date.now());
  await m.setOpening({ shopId: shop.id, day, amount: 1000, reason: 'शुरुआत' });
  await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 25 }] }); // +250
  await m.addCashEntry({ shopId: shop.id, day, kind: 'expense', amount: 50, category: 'electricity' });
  let d = await m.loadCashDay(shop.id, day);
  assert.equal(d.expected, 1200);

  // Count: 2×500 + 1×100 + 4×20 + coins 5 = 1185 → ₹15 कम.
  await assert.rejects(m.closeDay({ shopId: shop.id, day, denoms: { 300: 1 } }), code(/amount/));
  await assert.rejects(m.closeDay({ shopId: shop.id, day, denoms: { 500: 1.5 } }), code(/amount/));
  const close = await m.closeDay({ shopId: shop.id, day, denoms: { 500: 2, 100: 1, 20: 4, coins: 5 }, reason: 'छुट्टा कम', byName: 'रमेश' });
  assert.deepEqual([close.amount, close.expected, close.diff], [1185, 1200, -15]);
  d = await m.loadCashDay(shop.id, day);
  assert.deepEqual([d.closed, d.diff, d.late.count], [true, -15, 0]);
  const text = m.cashDayText(tHi, d, shop, 'hi');
  assert.match(text, /₹15 कम/);
  assert.match(text, /छुट्टा कम/);
  assert.match(m.cashDayText(tEn, d, shop, 'en'), /short/i);
  const csv = m.cashDayCSVRow(d);
  assert.equal(csv.length, m.CASH_DAYS_CSV_HEADERS.length);
  assert.deepEqual([csv[11], csv[12], csv[13]], [1200, 1185, -15]);

  // Locked: changes need a reason and are flagged.
  await assert.rejects(m.addCashEntry({ shopId: shop.id, day, kind: 'withdrawal', amount: 100 }), code(/reason/));
  await assert.rejects(m.closeDay({ shopId: shop.id, day, counted: 1200 }), code(/reason/));
  await assert.rejects(m.setOpening({ shopId: shop.id, day, amount: 1000 }), code(/reason/));
  await sleep(5);
  const late = await m.addCashEntry({ shopId: shop.id, day, kind: 'withdrawal', amount: 100, reason: 'भूल गए थे' });
  assert.equal(late.afterClose, true);
  // A bill after closing is a late entry too.
  await sleep(5);
  const lateSale = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 3 }] });
  d = await m.loadCashDay(shop.id, day);
  assert.equal(d.late.count, 2);
  assert.ok(d.late.ids.has(late.id) && d.late.ids.has(lateSale.id));
  assert.equal(d.expected, 1130);
  assert.equal(d.late.drift, -70);
  assert.equal(d.diff, 1185 - 1130, 'difference recomputed against the new expected');
  assert.match(m.cashDayText(tHi, d, shop, 'hi'), /2/);

  // Recount = a new close (with reason); history keeps both.
  const re = await m.closeDay({ shopId: shop.id, day, counted: 1130, reason: 'दोबारा गिना' });
  d = await m.loadCashDay(shop.id, day);
  assert.deepEqual([d.close.id, d.diff, d.closes.length], [re.id, 0, 2]);
  // Re-open = void the close (with reason); the day is open again and drops from past closings.
  await m.voidCashEntry({ entryId: re.id, reason: 'फिर से खोलो' });
  d = await m.loadCashDay(shop.id, day);
  assert.equal(d.close.id, close.id, 'voiding the recount falls back to the first close');
  await m.voidCashEntry({ entryId: close.id, reason: 'फिर से खोलो' });
  d = await m.loadCashDay(shop.id, day);
  assert.equal(d.closed, false);
  assert.equal((await m.loadClosings(shop.id)).length, 0);
  // Open again: plain additions need no reason.
  await m.addCashEntry({ shopId: shop.id, day, kind: 'added', amount: 10 });
  const entriesCsv = m.cashEntryCSVRows(await m.db.cashEntries.toArray());
  assert.ok(entriesCsv.every((r) => r.length === m.CASH_ENTRIES_CSV_HEADERS.length));
  assert.ok(entriesCsv.some((r) => r[2] === 'void' && r[7] === 'फिर से खोलो'));
});

test('carry-forward: opening defaults to the last counted closing; a different opening needs a reason', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-4');
  const today = m.dayKey(Date.now());
  const d1 = m.dayKey(Date.now() - 3 * DAY);
  const d2 = m.dayKey(Date.now() - 1 * DAY);
  await m.setOpening({ shopId: shop.id, day: d1, amount: 300, reason: 'start' });
  await m.addCashEntry({ shopId: shop.id, day: d1, kind: 'added', amount: 200 });
  await m.closeDay({ shopId: shop.id, day: d1, counted: 480 }); // ₹20 short
  // The day after (not closed) and today both carry ₹480 from d1's count.
  let y = await m.loadCashDay(shop.id, d2);
  assert.deepEqual([y.opening, y.openingSource, y.carried], [480, 'carried', { day: d1, amount: 480 }]);
  await m.closeDay({ shopId: shop.id, day: d2, counted: 480 });
  let t = await m.loadCashDay(shop.id, today);
  assert.deepEqual([t.opening, t.carried.day], [480, d2]);
  // Same as carried: no reason needed; different: reason required.
  await m.setOpening({ shopId: shop.id, day: today, amount: 480 });
  await assert.rejects(m.setOpening({ shopId: shop.id, day: today, amount: 450 }), code(/reason/));
  await m.setOpening({ shopId: shop.id, day: today, amount: 450, reason: 'रात को 30 निकाले' });
  t = await m.loadCashDay(shop.id, today);
  assert.deepEqual([t.opening, t.openingSource, t.openingEntry.reason], [450, 'entry', 'रात को 30 निकाले']);
  // A recount of an earlier day flows into the carried value.
  await m.closeDay({ shopId: shop.id, day: d2, counted: 470, reason: 'recount' });
  y = await m.loadCashDay(shop.id, d2);
  assert.equal(y.close.amount, 470);
  const past = await m.loadClosings(shop.id);
  assert.deepEqual(past.map((p) => p.day), [d2, d1]);
  assert.deepEqual(m.carriedFrom(await m.db.cashEntries.toArray(), today), { day: d2, amount: 470 });
});

test('backup v3 carries drawer entries; v2 files (no drawer) still restore', async () => {
  const m = loadPhone();
  const user = await m.register('cash@phone.test', 'secret123');
  const shop = await makeShop(m, user.id);
  const day = m.dayKey(Date.now());
  const cust = await m.addCustomer(shop.id, 'सीता');
  await m.addLedger(shop.id, cust.id, 'debit', 100);
  await m.addLedger(shop.id, cust.id, 'credit', 40, '', 'upi');
  await m.addCashEntry({ shopId: shop.id, day, kind: 'expense', amount: 25, category: 'transport' });
  await m.closeDay({ shopId: shop.id, day, denoms: { 100: 1, coins: 2 } });
  const original = await m.collectShop(shop.id);
  const file = await m.createBackup(shop.id);
  assert.equal(JSON.parse(file.text).version, 8);
  const { data } = await m.readBackup(file.text);
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(data.cashEntries, plain(original.cashEntries));
  assert.equal(data.ledger.find((e) => e.type === 'credit').method, 'upi');

  // Bad kind refused even with a valid checksum.
  const bad = JSON.parse(file.text);
  bad.data.cashEntries[0].kind = 'gift';
  bad.checksum = 'sha256:' + nodeCrypto.createHash('sha256').update(JSON.stringify(bad.data)).digest('hex');
  await assert.rejects(m.readBackup(JSON.stringify(bad)), (e) => e.code === 'invalid');

  // v2 file: no cashEntries, no ledger method.
  const v2data = plain(original);
  delete v2data.cashEntries;
  for (const e of v2data.ledger) delete e.method;
  const v2 = { format: 'dukaanmitra-backup', version: 2, exportedAt: Date.now(), shopId: shop.id, shopName: shop.name, data: v2data, checksum: 'sha256:' + nodeCrypto.createHash('sha256').update(JSON.stringify(v2data)).digest('hex') };
  const r2 = await m.readBackup(JSON.stringify(v2));
  await m.restoreBackup(r2.data, user.id);
  assert.equal(await m.db.cashEntries.count(), 0);
  const d = await m.loadCashDay(shop.id, day);
  assert.equal(d.cashIn.udhaar, 40, 'old payments without a method count as cash');
  // Restoring the v3 file brings the drawer back.
  await m.restoreBackup(data, user.id);
  assert.equal(await m.db.cashEntries.count(), 2);
  assert.equal((await m.loadCashDay(shop.id, day)).close.amount, 102);
});

test('two phones sync drawer entries through Supabase idempotently; CHECK refuses unknown kinds', async () => {
  const mock = createMock();
  after(() => mock.close());
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const EMAIL = 'galla@shop.test';
  const PASS = 'secret123';

  const A = loadPhone();
  const today = A.dayKey(Date.now());
  const userA = await A.register(EMAIL, PASS);
  const shop = await makeShop(A, userA.id);
  const oil = await product(A, shop);
  await A.cloudSignUp(EMAIL, PASS);
  assert.deepEqual(await A.linkShop(shop, userA.id), { status: 'linked' });

  await A.setOpening({ shopId: shop.id, day: today, amount: 500, reason: 'start' });
  await A.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 10 }], payments: [{ method: 'cash', amount: 100, tendered: 200 }] });
  const cust = await A.addCustomer(shop.id, 'गोपाल');
  await A.addLedger(shop.id, cust.id, 'debit', 80);
  await A.addLedger(shop.id, cust.id, 'credit', 30, '', 'upi');
  const exp = await A.addCashEntry({ shopId: shop.id, day: today, kind: 'expense', amount: 60, category: 'rent', note: 'दुकान' });
  await A.addCashEntry({ shopId: shop.id, day: today, kind: 'supplier', amount: 90, supplierId: 'sup-9', supplierName: 'मेहता' });
  // First push: the answer is lost after commit → retry must not duplicate.
  mock.faults.push({ table: 'cash_entries', status: 503, afterCommit: true, times: 1 });
  const r1 = await A.syncNow();
  assert.ok(r1.error, 'first push reported a failure');
  assert.ok(await A.pendingCount(shop.id) > 0, 'outbox kept until the server confirms');
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(await A.pendingCount(shop.id), 0);
  assert.equal(mock.rows('cash_entries').length, 3, 'idempotent: no duplicates after retry');
  const srvExp = mock.rows('cash_entries').find((x) => x.id === exp.id);
  assert.deepEqual([srvExp.kind, Number(srvExp.amount), srvExp.category, srvExp.day], ['expense', 60, 'rent', today]);
  assert.equal(mock.rows('credit_ledger').find((x) => x.type === 'credit').method, 'upi');

  // Phone B restores and sees the same drawer.
  const B = loadPhone();
  await B.recoverFromCloud(EMAIL, PASS);
  const a1 = await A.loadCashDay(shop.id, today);
  let b1 = await B.loadCashDay(shop.id, today);
  assert.equal(a1.expected, 500 + 100 - 60 - 90);
  assert.deepEqual([b1.expected, b1.opening, b1.upi.udhaar, b1.cashIn.udhaar], [a1.expected, 500, 30, 0]);
  assert.equal(b1.manual.find((e) => e.kind === 'supplier').supplierId, 'sup-9');

  // B closes the day (counted by notes); A adds a late withdrawal with a reason; both agree after sync.
  await B.closeDay({ shopId: shop.id, day: today, denoms: { 200: 2, 50: 1 }, byName: 'B' });
  assert.equal((await B.syncNow()).error, undefined);
  assert.equal((await A.syncNow()).error, undefined);
  let a2 = await A.loadCashDay(shop.id, today);
  assert.deepEqual([a2.closed, a2.close.amount, a2.diff, a2.close.denoms], [true, 450, 0, { 200: 2, 50: 1 }]);
  await assert.rejects(A.addCashEntry({ shopId: shop.id, day: today, kind: 'withdrawal', amount: 50 }), code(/reason/));
  await sleep(5);
  await A.addCashEntry({ shopId: shop.id, day: today, kind: 'withdrawal', amount: 50, reason: 'घर खर्च' });
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal((await B.syncNow()).error, undefined);
  a2 = await A.loadCashDay(shop.id, today);
  b1 = await B.loadCashDay(shop.id, today);
  for (const d of [a2, b1]) assert.deepEqual([d.expected, d.late.count, d.diff], [400, 1, 50]);
  assert.equal(mock.rows('cash_entries').length, 5);
  // Syncing again moves nothing.
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(mock.rows('cash_entries').length, 5);

  // The server's CHECK refuses unknown kinds / categories.
  const { createClient } = require('@supabase/supabase-js');
  const other = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, 'test-anon-key', { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: EMAIL, password: PASS });
  const uid = (await other.auth.getSession()).data.session.user.id;
  const { toRemote } = require('../src/lib/syncSchema.ts');
  const badKind = await other.from('cash_entries').insert([toRemote('cash_entries', { ...exp, id: crypto.randomUUID(), kind: 'gift' }, uid)]);
  assert.equal(badKind.error?.code, '23514');
  const badCat = await other.from('cash_entries').insert([toRemote('cash_entries', { ...exp, id: crypto.randomUUID(), category: 'party' }, uid)]);
  assert.equal(badCat.error?.code, '23514');
});

test('later pending settlements belong to receipt day, preserve earlier cash, and survive backup', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'receipt-owner');
  const oil = await product(m, shop);
  const now = Date.now();
  const today = m.dayKey(now);
  const yesterday = m.dayKey(now - DAY);
  for (const to of ['cash', 'upi']) {
    const sale = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 5 }], payments: [{ method: 'cash', amount: 10, tendered: 20 }, { method: 'upi', amount: 40, upi: 'pending' }] });
    await m.db.sales.update(sale.id, { day: yesterday, createdAt: now - DAY });
    await m.settlePendingUpi({ saleId: sale.id, to });
    await assert.rejects(m.settlePendingUpi({ saleId: sale.id, to }), code(/notPending/));
  }
  const old = await m.loadCashDay(shop.id, yesterday);
  const current = await m.loadCashDay(shop.id, today);
  assert.deepEqual([old.cashIn.sales, old.upi.sales, old.tendered, old.change], [20, 0, 40, 20]);
  assert.deepEqual([current.cashIn.sales, current.upi.sales, current.tendered], [40, 40, 0]);
  assert.ok((await m.loadAllCashDays(shop.id)).some((d) => d.day === today));
  const backup = await m.readBackup((await m.createBackup(shop.id)).text);
  assert.equal(backup.data.sales.flatMap(m.paymentsOf).filter((p) => p.confirmedAt !== undefined).length, 2);
  m.db.close();
});

test('returns accept 250g, reject fractions of packs and excess precision, and cap remaining stock', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'return-owner');
  const loose = await product(m, shop, { unit: 'kg', sellPrice: 100 });
  const pack = await product(m, shop);
  const sale = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: loose, qty: 1 }, { product: pack, qty: 1 }] });
  const ret = (index, qty) => m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index, qty }], reason: 'returned', refundMethod: 'cash' });
  assert.equal((await ret(0, 0.25)).amount, 25);
  for (const [i, q] of [[0, 0.8], [0, 0.001], [1, 0.5]]) await assert.rejects(ret(i, q), code(/over/));
  assert.equal((await ret(0, 0.75)).amount, 75);
  assert.equal((await m.db.products.get(loose.id)).qty, 50);
  m.db.close();
});

test('Hindi payment input preserves cash, paise, split remainder and change', () => {
  const { paymentInput, parseMoney } = require('../src/lib/money.ts');
  const { formPlan, changeFor } = require('../src/lib/payments.ts');
  assert.equal(paymentInput('₹५००'), '500');
  assert.equal(paymentInput('१२५.५०'), '125.50');
  assert.equal(changeFor(parseMoney(paymentInput('५००')), 125.5), 374.5);
  const plan = formPlan(200, 'cash', { cash: '१२५.५०', upi: '' });
  assert.deepEqual(plan.amounts, { cash: 125.5, upi: 74.5, credit: 0 });
  assert.equal(plan.invalid, false);
});
