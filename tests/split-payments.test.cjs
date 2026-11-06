/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Split payments: one bill paid by cash + UPI + udhaar, cash tendered / change, UPI that waits for the
// shopkeeper's "पैसे आ गए", returns on split bills (refund split per method, udhaar on the ledger),
// old single-method bills, backups, and two phones syncing split bills through the fake Supabase.
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
async function today(m, shopId) {
  const sales = await m.db.sales.where('shopId').equals(shopId).toArray();
  const corrections = await m.db.corrections.where('shopId').equals(shopId).toArray();
  const ledger = await m.db.ledger.where('shopId').equals(shopId).filter((e) => e.type === 'credit').toArray();
  return m.computeDayStats(sales, corrections, ledger);
}
const balance = async (m, id) => (await m.db.customers.get(id)).balance;
const ledgerSum = async (m, id) =>
  Math.round((await m.db.ledger.where('customerId').equals(id).toArray()).reduce((a, e) => a + (e.type === 'debit' ? e.amount : -e.amount), 0) * 100) / 100;

test('split totals, auto-fill of the remainder, change, UPI link (pure helpers)', () => {
  const m = loadPhone();
  // Auto-fill: the one method left empty takes the rest.
  let plan = m.formPlan(100, 'cash', { cash: '50', upi: '30', credit: '' });
  assert.deepEqual(plan.amounts, { cash: 50, upi: 30, credit: 20 });
  assert.equal(plan.auto, 'credit');
  assert.equal(plan.left, 0);
  plan = m.formPlan(100, 'cash', { cash: '', upi: '' });
  assert.equal(plan.left, 100, 'two empty boxes: nothing guessed');
  plan = m.formPlan(100, 'cash', { cash: '70', upi: '50' });
  assert.equal(plan.left, -20, 'too much is reported');
  assert.deepEqual(m.formPlan(100, 'upi', null).amounts, { cash: 0, upi: 100, credit: 0 }, 'one-tap single payment');
  assert.deepEqual(m.startSplit('cash'), { cash: '', upi: '' });

  // Parts must add up to the bill; cash tendered must cover the cash part; UPI needs a choice.
  const parts = m.buildPayments(100, [
    { method: 'cash', amount: 50, tendered: 200 },
    { method: 'upi', amount: 30, upi: 'paid', ref: ' 4821 ' },
    { method: 'credit', amount: 20 },
  ]);
  assert.equal(parts[0].change, 150);
  assert.equal(parts[1].ref, '4821');
  assert.equal(m.paymentKind(parts), 'split');
  assert.throws(() => m.buildPayments(100, [{ method: 'cash', amount: 60 }, { method: 'upi', amount: 30, upi: 'paid' }]), (e) => e.code === 'sum');
  assert.throws(() => m.buildPayments(100, [{ method: 'cash', amount: 100, tendered: 50 }]), (e) => e.code === 'tendered');
  assert.throws(() => m.buildPayments(100, [{ method: 'upi', amount: 100 }]), (e) => e.code === 'upiChoice');
  assert.throws(() => m.buildPayments(100, [{ method: 'cash', amount: -5 }, { method: 'upi', amount: 105, upi: 'paid' }]), (e) => e.code === 'negative');
  assert.equal(m.changeFor(500, 135.5), 364.5);
  assert.equal(m.changeFor(100, 135), 0);
  assert.deepEqual([...m.CASH_NOTES], [10, 20, 50, 100, 200, 500, 2000]);

  const link = m.upiLink('sharma@okbank', 'शर्मा किराना', 30, 'Bill 12');
  const u = new URL(link);
  assert.equal(u.protocol, 'upi:');
  assert.equal(u.searchParams.get('pa'), 'sharma@okbank');
  assert.equal(u.searchParams.get('am'), '30.00');
  assert.equal(u.searchParams.get('cu'), 'INR');
  assert.equal(u.searchParams.get('pn'), 'शर्मा किराना');
  assert.ok(!link.includes('+'), 'spaces encoded as %20 for UPI apps');
  assert.ok(m.isUpiId('sharma@okbank') && !m.isUpiId('not an id'));
});

test('cash + UPI (pending) + udhaar bill: ledger, today, alerts, WhatsApp text, CSV; confirm / convert pending UPI', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-1');
  const oil = await product(m, shop);
  const lines = [{ product: oil, qty: 10 }]; // ₹100

  // Udhaar part without a customer is refused and changes nothing.
  await assert.rejects(
    m.recordSale({ shopId: shop.id, payment: 'cash', lines, payments: [{ method: 'cash', amount: 80 }, { method: 'credit', amount: 20 }] }),
    (e) => e instanceof m.PaymentError && e.code === 'customer',
  );
  assert.equal(await m.db.sales.count(), 0);
  assert.equal((await m.db.products.get(oil.id)).qty, 50);

  const sale = await m.recordSale({
    shopId: shop.id,
    payment: 'cash',
    lines,
    newCustomer: { name: 'रामू' },
    payments: [
      { method: 'cash', amount: 50, tendered: 100 },
      { method: 'upi', amount: 30, upi: 'pending' },
      { method: 'credit', amount: 20 },
    ],
  });
  assert.equal(sale.payment, 'split');
  assert.deepEqual(sale.payments.map((p) => [p.method, p.amount, p.status]), [['cash', 50, 'paid'], ['upi', 30, 'pending'], ['credit', 20, 'paid']]);
  assert.equal(sale.payments[0].change, 50, 'लौटाना ₹50');
  assert.ok(sale.customerId);
  assert.equal(await balance(m, sale.customerId), 20, 'only the udhaar part is owed');
  assert.equal(await ledgerSum(m, sale.customerId), 20);
  assert.equal((await m.db.products.get(oil.id)).qty, 40);

  let st = await today(m, shop.id);
  assert.deepEqual([st.total, st.cash, st.upi, st.upiPending, st.credit, st.splitCount], [100, 50, 0, 30, 20, 1]);
  let al = m.computeAlerts(await m.db.products.toArray(), shop, Date.now(), await m.db.sales.toArray());
  assert.deepEqual(al.pendingUpi.map((s) => [s.id, s.pending]), [[sale.id, 30]]);

  const text = m.billText(tHi, sale, shop, 'hi');
  assert.match(text, /भुगतान: नकद ₹50 \+ UPI ₹30 \+ उधार ₹20/);
  assert.match(text, /दिए ₹100 · लौटाए ₹50/);
  assert.match(text, /UPI बाकी: ₹30/);
  assert.match(text, /UPI: sharma@okbank/);
  assert.match(m.billText(tEn, sale, shop, 'en'), /Payment: Cash ₹50 \+ UPI ₹30 \+ Credit ₹20/);
  const row = [...m.salePaymentCSV(sale)];
  assert.deepEqual(row, [50, 0, 30, 20, 100, 50, '']);
  assert.equal(m.SALES_CSV_HEADERS.length, 18);

  // "पैसे आ गए" later, with the last digits of the UTR.
  const confirmed = await m.settlePendingUpi({ saleId: sale.id, to: 'upi', ref: '7731' });
  assert.deepEqual(confirmed.payments[1], { method: 'upi', amount: 30, status: 'paid', confirmedAt: confirmed.payments[1].confirmedAt, ref: '7731' });
  await assert.rejects(m.settlePendingUpi({ saleId: sale.id, to: 'upi' }), (e) => e.code === 'notPending');
  st = await today(m, shop.id);
  assert.deepEqual([st.total, st.cash, st.upi, st.upiPending, st.credit], [100, 50, 30, 0, 20]);
  al = m.computeAlerts(await m.db.products.toArray(), shop, Date.now(), await m.db.sales.toArray());
  assert.equal(al.pendingUpi.length, 0, 'gone from alerts once confirmed');
  const synced = (await m.db.outbox.toArray()).filter((o) => o.table === 'sales' && o.rowId === sale.id).pop();
  assert.equal(synced.payload.payments[1].status, 'paid', 'confirmation is queued for sync');

  // A pending UPI that never came: converted to udhaar (hits the ledger) or paid in cash.
  const b2 = await m.recordSale({ shopId: shop.id, payment: 'upi', lines: [{ product: oil, qty: 4 }], payments: [{ method: 'upi', amount: 40, upi: 'pending' }] });
  assert.equal(b2.payment, 'upi');
  await assert.rejects(m.settlePendingUpi({ saleId: b2.id, to: 'credit' }), (e) => e.code === 'customer');
  const moved = await m.settlePendingUpi({ saleId: b2.id, to: 'credit', customerId: sale.customerId });
  assert.deepEqual(moved.payments.map((p) => [p.method, p.amount, p.convertedFrom]), [['credit', 40, 'upi']]);
  assert.equal(moved.payment, 'credit');
  assert.equal(await balance(m, sale.customerId), 60);
  assert.equal(await ledgerSum(m, sale.customerId), 60);
  const b3 = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 2 }], payments: [{ method: 'cash', amount: 5 }, { method: 'upi', amount: 15, upi: 'pending' }] });
  const cashed = await m.settlePendingUpi({ saleId: b3.id, to: 'cash' });
  assert.deepEqual(cashed.payments.map((p) => [p.method, p.amount]), [['cash', 5], ['cash', 15]]);
  assert.equal(m.partSum(cashed.payments, 'cash'), 20);
  assert.ok(cashed.payments[1].confirmedAt >= b3.createdAt, 'conversion keeps its receipt timestamp');
  assert.equal(cashed.payment, 'cash');
  st = await today(m, shop.id);
  assert.deepEqual([st.total, st.cash, st.upi, st.upiPending, st.credit], [160, 70, 30, 0, 60]);
});

test('returns on split bills: refund split per method with caps, pending UPI reduced first, udhaar on the ledger', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-2');
  const oil = await product(m, shop);
  const cust = await m.addCustomer(shop.id, 'श्याम');
  // ₹100 = cash 50 + UPI 30 (received) + udhaar 20.
  const sale = await m.recordSale({
    shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 10 }], customerId: cust.id,
    payments: [{ method: 'cash', amount: 50 }, { method: 'upi', amount: 30, upi: 'paid' }, { method: 'credit', amount: 20 }],
  });
  assert.deepEqual(m.refundMethodsFor(sale, []), ['credit', 'cash', 'upi']);

  // Return 4 (₹40), reduce udhaar first: only ₹20 of udhaar exists, the other ₹20 goes back in cash.
  const c1 = await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 4 }], reason: 'वापस', refundMethod: 'credit' });
  assert.deepEqual(c1.refunds, [{ method: 'credit', amount: 20 }, { method: 'cash', amount: 20 }]);
  assert.equal(await balance(m, cust.id), 0, 'udhaar part cleared, never below the bill');
  assert.equal(await ledgerSum(m, cust.id), 0);
  const ret = (await m.db.ledger.toArray()).find((e) => e.correctionId === c1.id);
  assert.deepEqual([ret.type, ret.kind, ret.amount], ['credit', 'return', 20]);

  let s = await m.db.sales.get(sale.id);
  assert.deepEqual(m.refundMethodsFor(s, [c1]), ['cash', 'upi'], 'no udhaar left to reduce');
  await assert.rejects(m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'x', refundMethod: 'credit' }), (e) => e.code === 'method');

  // Return 3 (₹30) by UPI; then cancel the rest (₹30): only ₹30 of money is left, all cash.
  const c2 = await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 3 }], reason: 'खराब', refundMethod: 'upi' });
  assert.deepEqual(c2.refunds, [{ method: 'upi', amount: 30 }]);
  const c3 = await m.correctSale({ saleId: sale.id, type: 'cancel', reason: 'गलत बिल', refundMethod: 'cash' });
  assert.deepEqual(c3.refunds, [{ method: 'cash', amount: 30 }]);
  s = await m.db.sales.get(sale.id);
  assert.equal(s.status, 'cancelled');
  assert.equal(s.returnedTotal, 100);
  assert.equal((await m.db.products.get(oil.id)).qty, 50, 'all stock back');
  let st = await today(m, shop.id);
  assert.deepEqual([st.total, st.cash, st.upi, st.credit, st.returns], [0, 0, 0, 0, 100], 'every method nets to zero');

  // Bill with pending UPI: a return first reduces the UPI that never arrived (no money moves).
  const b = await m.recordSale({
    shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 10 }],
    payments: [{ method: 'cash', amount: 40 }, { method: 'upi', amount: 60, upi: 'pending' }],
  });
  const p1 = await m.correctSale({ saleId: b.id, type: 'return', lines: [{ index: 0, qty: 5 }], reason: 'वापस', refundMethod: 'cash' });
  assert.deepEqual(p1.refunds, [{ method: 'upiPending', amount: 50 }]);
  let bs = await m.db.sales.get(b.id);
  assert.deepEqual(bs.payments.map((p) => [p.method, p.amount, p.status]), [['cash', 40, 'paid'], ['upi', 10, 'pending']]);
  assert.equal(m.pendingUpi(bs), 10);
  st = await today(m, shop.id);
  assert.deepEqual([st.total, st.cash, st.upiPending], [50, 40, 10]);
  bs = await m.settlePendingUpi({ saleId: b.id, to: 'upi' });
  const p2 = await m.correctSale({ saleId: b.id, type: 'cancel', reason: 'रद्द', refundMethod: 'upi' });
  assert.deepEqual(p2.refunds, [{ method: 'upi', amount: 10 }, { method: 'cash', amount: 40 }], 'UPI refund capped at UPI received; the rest goes back as cash');
  st = await today(m, shop.id);
  assert.deepEqual([st.total, st.cash, st.upi, st.upiPending], [0, 0, 0, 0], 'no method goes negative');

  // An explicit cross-method refund is allowed (and recorded) when the user asks for it.
  const x = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 2 }], payments: [{ method: 'cash', amount: 20 }] });
  assert.equal(m.crossAmount(x, [], 20, 'upi'), 20);
  await assert.rejects(m.correctSale({ saleId: x.id, type: 'cancel', reason: 'x', refundMethod: 'upi' }), (e) => e.code === 'method');
  const xc = await m.correctSale({ saleId: x.id, type: 'cancel', reason: 'ग्राहक ने UPI माँगा', refundMethod: 'upi', crossMethod: true });
  assert.deepEqual(xc.refunds, [{ method: 'upi', amount: 20 }]);
  assert.equal(xc.crossMethod, true);

  // Whole bill pending UPI and cancelled: nothing to choose, nothing handed back.
  const z = await m.recordSale({ shopId: shop.id, payment: 'upi', lines: [{ product: oil, qty: 1 }], payments: [{ method: 'upi', amount: 10, upi: 'pending' }] });
  assert.deepEqual(m.refundMethodsFor(z, []), []);
  const zc = await m.correctSale({ saleId: z.id, type: 'cancel', reason: 'नहीं लिया', refundMethod: 'upi' });
  assert.deepEqual(zc.refunds, [{ method: 'upiPending', amount: 10 }]);
  const al = m.computeAlerts([], shop, Date.now(), await m.db.sales.toArray());
  assert.equal(al.pendingUpi.length, 0, 'cancelled bills never ask for UPI');
});

test('old single-method bills keep working; backups v2 carry split bills and v1 files still restore', async () => {
  const m = loadPhone();
  const user = await m.register('split@phone.test', 'secret123');
  const shop = await makeShop(m, user.id);
  const oil = await product(m, shop);
  const cust = await m.addCustomer(shop.id, 'गीता');
  // A pre-v5 credit bill (no payments) as it would come from an old phone or the cloud.
  const t = Date.now();
  const legacy = { id: 'legacy-1', shopId: shop.id, items: [{ productId: oil.id, nameHi: 'तेल', nameEn: 'Oil', unit: 'pcs', qty: 2, price: 10, cost: 8 }], total: 20, cost: 16, payment: 'credit', customerId: cust.id, createdAt: t, day: require('../src/lib/dates.ts').dayKey(t), updatedAt: t };
  await m.db.sales.add(legacy);
  await m.addLedger(shop.id, cust.id, 'debit', 20);
  assert.deepEqual(m.paymentsOf(legacy), [{ method: 'credit', amount: 20, status: 'paid' }]);
  assert.deepEqual(m.refundMethodsFor(legacy, []), ['credit']);
  const lc = await m.correctSale({ saleId: 'legacy-1', type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'वापस', refundMethod: 'credit' });
  assert.deepEqual(lc.refunds, [{ method: 'credit', amount: 10 }]);
  assert.equal(await balance(m, cust.id), 10);
  // Legacy correction rows (no refunds) still count as one refund of refundMethod.
  assert.deepEqual(m.refundsOf({ refundMethod: 'cash', amount: 7 }), [{ method: 'cash', amount: 7 }]);

  await m.recordSale({
    shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 3 }], customerId: cust.id,
    payments: [{ method: 'cash', amount: 10, tendered: 50 }, { method: 'upi', amount: 15, upi: 'pending' }, { method: 'credit', amount: 5 }],
  });
  const original = await m.collectShop(shop.id);
  const file = await m.createBackup(shop.id);
  const parsed = JSON.parse(file.text);
  assert.equal(parsed.version, 8);
  const { data } = await m.readBackup(file.text);
  const plainJson = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(data.sales, plainJson(original.sales), 'split parts survive the file');
  assert.deepEqual(data.corrections, plainJson(original.corrections));

  // A broken split (parts more than the bill) is refused even with a valid checksum.
  const bad = JSON.parse(file.text);
  bad.data.sales.find((x) => x.payment === 'split').payments[0].amount = 999;
  bad.checksum = 'sha256:' + nodeCrypto.createHash('sha256').update(JSON.stringify(bad.data)).digest('hex');
  await assert.rejects(m.readBackup(JSON.stringify(bad)), (e) => e.code === 'invalid' && /payments \(sum\)/.test(e.detail));

  // A v1 file (made before split payments): no payments / refunds, still restores losslessly.
  const v1data = JSON.parse(JSON.stringify(original));
  for (const x of v1data.sales) {
    if (x.payment === 'split') x.payment = 'cash';
    delete x.payments;
  }
  for (const c of v1data.corrections) delete c.refunds;
  const v1 = { format: 'dukaanmitra-backup', version: 1, exportedAt: t, shopId: shop.id, shopName: shop.name, data: v1data, checksum: 'sha256:' + nodeCrypto.createHash('sha256').update(JSON.stringify(v1data)).digest('hex') };
  const r1 = await m.readBackup(JSON.stringify(v1));
  await m.restoreBackup(r1.data, user.id);
  const restored = await m.db.sales.get('legacy-1');
  assert.equal(restored.payments, undefined, 'row kept exactly as in the file');
  assert.deepEqual(m.paymentsOf(restored), [{ method: 'credit', amount: 20, status: 'paid' }]);
});

test('two phones sync split bills through Supabase: parts, pending UPI confirm, split refunds, schema checks', async () => {
  const mock = createMock();
  after(() => mock.close());
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const EMAIL = 'sharma@shop.test';
  const PASS = 'secret123';

  const A = loadPhone();
  const userA = await A.register(EMAIL, PASS);
  const shop = await makeShop(A, userA.id);
  const oil = await product(A, shop);
  await A.cloudSignUp(EMAIL, PASS);
  assert.deepEqual(await A.linkShop(shop, userA.id), { status: 'linked' });

  const sale = await A.recordSale({
    shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 10 }], newCustomer: { name: 'मोहन' },
    payments: [{ method: 'cash', amount: 50, tendered: 60 }, { method: 'upi', amount: 30, upi: 'pending' }, { method: 'credit', amount: 20 }],
  });
  const c = await A.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 4 }], reason: 'वापस', refundMethod: 'credit' });
  assert.deepEqual(c.refunds, [{ method: 'upiPending', amount: 30 }, { method: 'credit', amount: 10 }]);
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(await A.pendingCount(shop.id), 0);

  const srv = mock.rows('sales').find((x) => x.id === sale.id);
  assert.equal(srv.payment, 'split');
  assert.deepEqual(srv.payments.map((p) => [p.method, p.amount, p.status]), [['cash', 50, 'paid'], ['credit', 20, 'paid']], 'pending UPI fully reduced by the return');
  assert.deepEqual(mock.rows('sale_corrections').find((x) => x.id === c.id).refunds, c.refunds);

  // Phone B restores from the cloud: same parts, same udhaar, same day totals.
  const B = loadPhone();
  await B.recoverFromCloud(EMAIL, PASS);
  const sb = await B.db.sales.get(sale.id);
  assert.deepEqual(sb.payments, (await A.db.sales.get(sale.id)).payments);
  assert.deepEqual((await B.db.corrections.get(c.id)).refunds, c.refunds);
  assert.equal((await B.db.customers.get(sale.customerId)).balance, 10);
  assert.deepEqual(await today(B, shop.id), await today(A, shop.id));

  // B takes a new split bill with pending UPI; A confirms the money arrived; both agree.
  const s2 = await B.recordSale({
    shopId: shop.id, payment: 'cash', lines: [{ product: await B.db.products.get(oil.id), qty: 5 }],
    payments: [{ method: 'cash', amount: 20 }, { method: 'upi', amount: 30, upi: 'pending' }],
  });
  assert.equal((await B.syncNow()).error, undefined);
  assert.equal((await A.syncNow()).error, undefined);
  const pendA = A.computeAlerts([], shop, Date.now(), await A.db.sales.toArray());
  assert.deepEqual(pendA.pendingUpi.map((x) => x.id), [s2.id], "A sees B's pending UPI");
  await A.settlePendingUpi({ saleId: s2.id, to: 'upi', ref: '0042' });
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal((await B.syncNow()).error, undefined);
  const s2b = await B.db.sales.get(s2.id);
  assert.deepEqual(s2b.payments[1], { method: 'upi', amount: 30, status: 'paid', ref: '0042', confirmedAt: s2b.payments[1].confirmedAt });
  assert.equal(B.computeAlerts([], shop, Date.now(), await B.db.sales.toArray()).pendingUpi.length, 0);
  for (const phone of [A, B]) {
    const st = await today(phone, shop.id);
    assert.deepEqual([st.total, st.cash, st.upi, st.upiPending, st.credit], [110, 70, 30, 0, 10]);
  }

  // The server's CHECK accepts 'split' and refuses unknown payment kinds.
  const { createClient } = require('@supabase/supabase-js');
  const other = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, 'test-anon-key', { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: EMAIL, password: PASS });
  const uid = (await other.auth.getSession()).data.session.user.id;
  const { toRemote } = require('../src/lib/syncSchema.ts');
  const bad = await other.from('sales').insert([toRemote('sales', { ...sale, id: crypto.randomUUID(), payment: 'cheque' }, uid)]);
  assert.equal(bad.error?.code, '23514');
});
