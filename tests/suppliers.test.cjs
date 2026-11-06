/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Supplier payment diary: migration of free-text supplier names (products + galla), purchase bills
// (stock via moves, buy price + date, cash paid -> galla supplier payment, not an expense),
// append-only supplier ledger (partial payments, outstanding, due / overdue, returns, adjustments),
// WhatsApp orders -> purchase on receipt, backup v4 (+ older files), CSV, schema / sync columns
// and two phones syncing through the mock Supabase.
// Run: node tests/suppliers.test.cjs
process.env.TZ = 'Asia/Kolkata';
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
globalThis.WebSocket ??= class {};
globalThis.crypto ??= nodeCrypto.webcrypto;

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const SRC = path.join(__dirname, '..', 'src') + path.sep;
function loadPhone(factory) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  Dexie.dependencies.indexedDB = factory ?? new IDBFactory();
  return {
    ...require('../src/lib/db.ts'),
    ...require('../src/lib/ops.ts'),
    ...require('../src/lib/cash.ts'),
    ...require('../src/lib/alerts.ts'),
    ...require('../src/lib/dates.ts'),
    ...require('../src/lib/auth.ts'),
    ...require('../src/lib/cloud.ts'),
    ...require('../src/lib/sync.ts'),
    ...require('../src/lib/backup.ts'),
    ...require('../src/lib/syncSchema.ts'),
    ...require('../src/lib/whatsapp.ts'),
    sp: require('../src/lib/suppliers.ts'),
    mig: require('../src/lib/supplierMigrate.ts'),
    rp: require('../src/lib/report.ts'),
  };
}
const msgs = (l) => JSON.parse(fs.readFileSync(path.join(SRC, 'messages', `${l}.json`), 'utf8'));
const tFor = (l) => createTranslator({ locale: l, messages: msgs(l) });
const DAY = 86_400_000;

async function makeShop(m, ownerId = 'owner-1', id = 'shop-1') {
  const now = Date.now();
  const shop = { id, ownerId, name: 'गुप्ता किराना', ownerName: 'सुरेश', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now };
  await m.db.transaction('rw', [m.db.shops, m.db.outbox], async () => {
    await m.db.shops.add(shop);
    await m.enqueue('shops', 'upsert', shop.id, shop);
  });
  return shop;
}
async function goods(m, shop) {
  const sugar = await m.saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 2, sellPrice: 45, buyPrice: 40, lowStockAt: 5 });
  const salt = await m.saveProduct(shop.id, { nameHi: 'नमक', nameEn: 'Salt', unit: 'pkt', qty: 1, sellPrice: 28, buyPrice: 0, lowStockAt: 4 });
  const oil = await m.saveProduct(shop.id, { nameHi: 'तेल', nameEn: 'Oil', unit: 'ltr', qty: 20, sellPrice: 150, buyPrice: 140, lowStockAt: 2 });
  return { sugar, salt, oil };
}
const code = (c) => (e) => e.code === c;

/* ------------------------------------------------------------------ */

test('migration v7 -> v8: free-text supplier names (products + galla) become supplier records; nothing lost; same ids on every phone', async () => {
  const seed = async (factory) => {
    Dexie.dependencies.indexedDB = factory;
    const old = new Dexie('dukaanmitra');
    old.version(7).stores({
      users: 'id, &email', shops: 'id, ownerId', products: 'id, shopId, barcode, updatedAt', customers: 'id, shopId, updatedAt',
      sales: 'id, shopId, day, createdAt, [shopId+day], customerId', ledger: 'id, shopId, customerId, createdAt', outbox: '++seq, table, createdAt, shopId',
      saleDrafts: 'shopId', corrections: 'id, shopId, saleId, createdAt, [shopId+day]', stockMoves: 'id, shopId, productId, createdAt', meta: 'key',
      cashEntries: 'id, shopId, day, [shopId+day], createdAt',
    });
    await old.open();
    const t = 1_700_000_000_000;
    const p = (id, nameHi, supplier, at) => ({ id, shopId: 's1', nameHi, nameEn: '', unit: 'pcs', qty: 1, buyPrice: 10, sellPrice: 12, lowStockAt: 1, salesCount: 0, supplier, createdAt: at, updatedAt: at });
    await old.table('products').bulkAdd([
      p('p1', 'आटा', 'Sharma Traders', t + 1),
      p('p2', 'दाल', '  sharma   traders ', t + 2), // same supplier, typed differently
      p('p3', 'तेल', 'मेहता एजेंसी', t + 3),
      p('p4', 'साबुन', undefined, t + 4),
    ]);
    await old.table('cashEntries').bulkAdd([
      { id: 'c1', shopId: 's1', day: '2026-10-01', kind: 'supplier', amount: 500, supplierName: 'मेहता एजेंसी', createdAt: t + 10 },
      { id: 'c2', shopId: 's1', day: '2026-10-02', kind: 'supplier', amount: 300, supplierName: 'Raju Dairy', createdAt: t + 11 },
      { id: 'c3', shopId: 's1', day: '2026-10-03', kind: 'supplier', amount: 200, supplierId: 'sup-old', supplierName: 'Gupta Bros', createdAt: t + 12 },
      { id: 'c4', shopId: 's1', day: '2026-10-03', kind: 'expense', amount: 50, category: 'tea', createdAt: t + 13 },
    ]);
    old.close();
  };
  const fA = new IDBFactory();
  await seed(fA);
  const A = loadPhone(fA);
  await A.db.open();
  assert.equal(A.db.verno, 10); // v9 (repeat orders) adds tables, v10 sets product kind only
  const sups = (await A.db.suppliers.toArray()).sort((a, b) => a.createdAt - b.createdAt);
  assert.deepEqual(sups.map((s) => s.name), ['Sharma Traders', 'मेहता एजेंसी', 'Raju Dairy', 'Gupta Bros']);
  assert.equal(sups[0].id, A.mig.supplierIdFor('s1', 'SHARMA traders'), 'name-based id');
  assert.equal(sups[3].id, 'sup-old', 'an existing galla supplierId is kept');
  assert.equal(sups[0].items, 'आटा, दाल', 'what they supply, from the products');
  const prods = Object.fromEntries((await A.db.products.toArray()).map((x) => [x.id, x]));
  assert.equal(prods.p1.supplierId, sups[0].id);
  assert.equal(prods.p2.supplierId, sups[0].id);
  assert.equal(prods.p2.supplier, '  sharma   traders ', 'free text kept exactly');
  assert.equal(prods.p3.supplierId, sups[1].id);
  assert.equal(prods.p4.supplierId, undefined);
  assert.equal(await A.db.cashEntries.count(), 4, 'galla entries untouched');
  assert.equal((await A.db.cashEntries.get('c2')).supplierId, undefined, 'append-only rows are not rewritten');
  const queued = (await A.db.outbox.toArray()).filter((o) => o.table === 'suppliers').map((o) => o.rowId).sort();
  assert.deepEqual(queued, sups.map((s) => s.id).sort(), 'new suppliers queued for the cloud');
  // Old galla payments show on the supplier (by name) but do not change the balance.
  const mehta = A.sp.gallaPaymentsOf(sups[1], await A.db.cashEntries.toArray());
  assert.deepEqual(mehta.map((e) => e.id), ['c1']);
  assert.equal(A.sp.outstandingOf(await A.db.supplierLedger.toArray()), 0);
  // Re-running the planner changes nothing (idempotent).
  const again = A.mig.planSuppliers(await A.db.products.toArray(), await A.db.cashEntries.toArray(), await A.db.suppliers.toArray(), Date.now());
  assert.deepEqual([again.created.length, again.links.length], [0, 0]);

  // A second phone with the same old data migrates to exactly the same rows (no duplicates after sync).
  const fB = new IDBFactory();
  await seed(fB);
  const B = loadPhone(fB);
  await B.db.open();
  const supsB = (await B.db.suppliers.toArray()).sort((a, b) => a.createdAt - b.createdAt);
  assert.deepEqual(supsB, sups);
});

test('purchase bill: stock up via moves, buy price + date updated, cash paid leaves the galla as a supplier payment (not an expense)', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const { sugar, salt } = await goods(m, shop);
  const today = m.dayKey(Date.now());
  const sup = await m.sp.saveSupplier(shop.id, { name: 'शर्मा ट्रेडर्स', phone: '98765 43210', items: 'चीनी, नमक', termsDays: 7 });
  assert.equal(sup.phone, '9876543210');
  await assert.rejects(m.sp.saveSupplier(shop.id, { name: '  शर्मा  ट्रेडर्स ' }), code('duplicate'));
  const before = Date.now();
  const id = 'bill-1';
  const pur = await m.sp.recordPurchase({ id, shopId: shop.id, supplierId: sup.id, day: today, billNo: 'A-17', lines: [{ productId: sugar.id, qty: 10, buyPrice: 42 }, { productId: salt.id, qty: 5, buyPrice: 20 }], paidCash: 300, paidUpi: 100, byName: 'सुरेश' });
  assert.deepEqual([pur.total, pur.paidCash, pur.paidUpi, pur.credit], [520, 300, 100, 120]);
  assert.equal(pur.dueDate, m.sp.addDaysKey(today, 7));
  assert.equal(pur.lines[0].prevBuyPrice, 40, 'old buy price kept on the bill');
  assert.equal(pur.lines[1].prevBuyPrice, undefined, 'salt had no buy price before');
  // Stock = sum of moves; the moves are tied to the bill (ids derived from it).
  const s2 = await m.db.products.get(sugar.id);
  assert.equal(s2.qty, 12);
  assert.equal((await m.db.products.get(salt.id)).qty, 6);
  const moves = await m.db.stockMoves.where('productId').equals(sugar.id).toArray();
  assert.deepEqual(moves.filter((x) => x.reason === 'purchase').map((x) => [x.id, x.delta, x.refId, x.note]), [[`pur-${id}-0`, 10, id, 'A-17']]);
  // Buy price (feeds the profit report's cost snapshot) + when it changed.
  assert.equal(s2.buyPrice, 42);
  assert.ok(s2.buyPriceAt >= before);
  assert.equal((await m.db.products.get(salt.id)).buyPrice, 20);
  const sale = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: s2, qty: 1 }] });
  assert.deepEqual([sale.items[0].cost, sale.items[0].costKnown], [42, true]);
  // Galla: one supplier payment of 300 (cash only; UPI never touches the drawer).
  const day = await m.loadCashDay(shop.id, today);
  const sup1 = day.manual.filter((e) => e.kind === 'supplier');
  assert.deepEqual(sup1.map((e) => [e.amount, e.supplierId, e.supplierName, e.id]), [[300, sup.id, 'शर्मा ट्रेडर्स', `${id}-galla`]]);
  assert.equal(day.expected, 45 - 300);
  // Ledger: bill 520, paid 300 cash + 100 UPI -> 120 owed.
  const led = await m.db.supplierLedger.where('supplierId').equals(sup.id).toArray();
  assert.deepEqual(led.map((e) => [e.type, e.amount, e.method ?? '']).sort(), [['payment', 100, 'upi'], ['payment', 300, 'cash'], ['purchase', 520, '']]);
  assert.equal(m.sp.outstandingOf(led), 120);
  // Retry / double tap with the same id records nothing twice.
  await m.sp.recordPurchase({ id, shopId: shop.id, supplierId: sup.id, day: today, lines: [{ productId: sugar.id, qty: 10, buyPrice: 42 }], paidCash: 0, paidUpi: 0 });
  assert.equal((await m.db.products.get(sugar.id)).qty, 11);
  assert.equal(await m.db.purchases.count(), 1);
  assert.equal(await m.db.supplierLedger.count(), 3);
  // Profit report: purchases and supplier payments are not expenses.
  const r = await m.rp.loadReport(shop.id, today, today);
  assert.equal(r.expenses.total, 0);
  assert.equal(r.notExpenses.supplier, 300);
  assert.deepEqual(r.purchases, { total: 520, bills: 1, paidUpi: 100 });
  assert.equal(r.margin, 3, 'sugar sold at 45 with the new buy price 42');
  const lines = m.rp.explainLines(tFor('hi'), r);
  assert.ok(lines.some((l) => l.includes('₹520') && l.includes('खर्चा नहीं')), lines.join('\n'));
  // Product without a supplier gets linked to the bill's supplier.
  assert.equal((await m.db.products.get(salt.id)).supplierId, sup.id);
  // Validation.
  await assert.rejects(m.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: today, lines: [{ productId: sugar.id, qty: 1, buyPrice: 10 }], paidCash: 11, paidUpi: 0 }), code('paid'));
  await assert.rejects(m.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: today, lines: [{ productId: sugar.id, qty: 1, buyPrice: 0 }], paidCash: 0, paidUpi: 0 }), code('price'));
  await assert.rejects(m.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: m.sp.addDaysKey(today, 1), lines: [{ productId: sugar.id, qty: 1, buyPrice: 1 }], paidCash: 0, paidUpi: 0 }), code('future'));
  await assert.rejects(m.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: today, lines: [], paidCash: 0, paidUpi: 0 }), code('lines'));
});

test('partial payments, outstanding, due / overdue badges (FIFO, bill-linked first); UPI stays out of the galla; closed galla gets a logged reason', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const { sugar, oil } = await goods(m, shop);
  const today = m.dayKey(Date.now());
  const sup = await m.sp.saveSupplier(shop.id, { name: 'मेहता एजेंसी', termsDays: 7 });
  const old = m.dayKey(Date.now() - 10 * DAY);
  await m.sp.recordPurchase({ id: 'p-old', shopId: shop.id, supplierId: sup.id, day: old, lines: [{ productId: oil.id, qty: 5, buyPrice: 100 }], paidCash: 0, paidUpi: 0 });
  let st = m.sp.supplierStatus(await m.db.supplierLedger.toArray(), today);
  assert.deepEqual([st.outstanding, st.overdue, st.state, st.nextDue], [500, 500, 'overdue', m.sp.addDaysKey(old, 7)]);
  assert.equal(m.sp.dueText(tFor('hi'), st, today), '₹500 बाकी · 3 दिन लेट');
  assert.equal(m.sp.dueText(tFor('en'), st, today), '₹500 owed · 3 days late');
  // Pay 200 cash later: galla supplier payment, outstanding 300 still overdue.
  await m.sp.paySupplier({ id: 'pay-1', shopId: shop.id, supplierId: sup.id, amount: 200, method: 'cash' });
  await m.sp.paySupplier({ id: 'pay-1', shopId: shop.id, supplierId: sup.id, amount: 200, method: 'cash' }); // retry
  assert.equal((await m.loadCashDay(shop.id, today)).manual.filter((e) => e.kind === 'supplier').reduce((a, e) => a + e.amount, 0), 200);
  // A new bill today (due in 7 days).
  await m.sp.recordPurchase({ id: 'p-new', shopId: shop.id, supplierId: sup.id, day: today, lines: [{ productId: sugar.id, qty: 10, buyPrice: 10 }], paidCash: 0, paidUpi: 0 });
  st = m.sp.supplierStatus(await m.db.supplierLedger.toArray(), today);
  assert.deepEqual([st.outstanding, st.overdue, st.dueSoon, st.state], [400, 300, 0, 'overdue']);
  assert.deepEqual(st.open.map((b) => [b.purchaseId, b.left, b.state]), [['p-old', 300, 'overdue'], ['p-new', 100, 'later']]);
  // Pay 300 by UPI: oldest bill cleared first; nothing in the galla.
  await m.sp.paySupplier({ shopId: shop.id, supplierId: sup.id, amount: 300, method: 'upi' });
  assert.equal((await m.loadCashDay(shop.id, today)).manual.filter((e) => e.kind === 'supplier').length, 1);
  st = m.sp.supplierStatus(await m.db.supplierLedger.toArray(), today);
  assert.deepEqual([st.outstanding, st.overdue, st.state, st.open.length], [100, 0, 'later', 1]);
  assert.equal(m.sp.dueText(tFor('hi'), st, today), '₹100 बाकी · 7 दिन में चुकाना');
  // Due soon: terms 2 days.
  const s2 = await m.sp.saveSupplier(shop.id, { name: 'Raju Dairy', termsDays: 2 });
  await m.sp.recordPurchase({ shopId: shop.id, supplierId: s2.id, day: today, lines: [{ productId: oil.id, qty: 1, buyPrice: 90 }], paidCash: 40, paidUpi: 0 });
  const dues = await m.sp.loadSupplierDues(shop.id, today);
  assert.deepEqual(dues.map((d) => [d.supplier.name, d.status.dueSoon, d.status.state]), [['Raju Dairy', 50, 'soon']]);
  // Due today / no terms.
  assert.equal(m.sp.dueState(today, today), 'today');
  assert.equal(m.sp.dueState(undefined, today), 'none');
  // A payment tied to a bill settles that bill first (not FIFO).
  const pure = [
    { id: 'a', type: 'purchase', amount: 100, day: '2026-10-01', purchaseId: 'A', dueDate: '2026-10-05', createdAt: 1 },
    { id: 'b', type: 'purchase', amount: 50, day: '2026-10-02', purchaseId: 'B', dueDate: '2026-10-06', createdAt: 2 },
    { id: 'c', type: 'payment', amount: 50, day: '2026-10-02', purchaseId: 'B', createdAt: 3 },
  ];
  assert.deepEqual(m.sp.supplierStatus(pure, '2026-10-10').open.map((b) => [b.purchaseId, b.left]), [['A', 100]]);
  // Overpaying = advance (negative balance), never hidden.
  await m.sp.paySupplier({ shopId: shop.id, supplierId: s2.id, amount: 80, method: 'upi' });
  const st2 = m.sp.supplierStatus(await m.db.supplierLedger.where('supplierId').equals(s2.id).toArray(), today);
  assert.equal(st2.outstanding, -30);
  assert.equal(m.sp.dueText(tFor('hi'), st2, today), '₹30 एडवांस दिया हुआ');
  // Closed galla: the cash payment is still recorded, marked after-close with a reason.
  await m.closeDay({ shopId: shop.id, day: today, counted: 0, reason: 'गिनती' });
  await m.sp.paySupplier({ shopId: shop.id, supplierId: sup.id, amount: 10, method: 'cash', closedReason: 'डायरी से भुगतान' });
  const late = (await m.loadCashDay(shop.id, today)).manual.find((e) => e.amount === 10);
  assert.deepEqual([late.afterClose, late.reason], [true, 'डायरी से भुगतान']);
  await assert.rejects(m.sp.paySupplier({ shopId: shop.id, supplierId: sup.id, amount: 0, method: 'cash' }), code('amount'));
});

test('WhatsApp order from low stock: suggested qty = target − stock (units), saved as ordered, received into a purchase with the received qty', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const { sugar, salt, oil } = await goods(m, shop);
  // Suggested quantities.
  assert.equal(m.sp.suggestQty({ unit: 'pcs', qty: 2, lowStockAt: 5 }), 8, '2 × 5 − 2');
  assert.equal(m.sp.suggestQty({ unit: 'pcs', qty: 2, lowStockAt: 5, reorderTo: 25 }), 23);
  assert.equal(m.sp.suggestQty({ unit: 'kg', qty: 1.2, lowStockAt: 3 }), 5, 'kg rounds up to 0.5');
  assert.equal(m.sp.suggestQty({ unit: 'pcs', qty: -4, lowStockAt: 3 }), 6, 'stock below zero counts as 0');
  assert.equal(m.sp.suggestQty({ unit: 'pcs', qty: 30, lowStockAt: 3 }), 1, 'never 0');
  const sup = await m.sp.saveSupplier(shop.id, { name: 'Sharma Traders', phone: '9876543210', termsDays: 15 });
  await m.saveProduct(shop.id, { ...sugar, supplier: 'sharma traders' }, sugar.id); // typed name links to the record
  assert.equal((await m.db.products.get(sugar.id)).supplierId, sup.id);
  const products = await m.db.products.toArray();
  const alerts = m.computeAlerts(products, await m.db.shops.get(shop.id), Date.now());
  const groups = m.sp.orderGroups([...alerts.shortage, ...alerts.low], await m.db.suppliers.toArray());
  assert.deepEqual(Object.fromEntries([...groups].map(([k, ps]) => [k, ps.map((p) => p.nameEn)])), { [sup.id]: ['Sugar'], '': ['Salt'] });
  // Salt had no supplier: linking from the order screen.
  await m.sp.linkProducts([salt.id], sup.id);
  assert.equal((await m.db.products.get(salt.id)).supplier, 'Sharma Traders');
  const lines = [{ productId: sugar.id, qty: m.sp.suggestQty(await m.db.products.get(sugar.id)) }, { productId: salt.id, qty: 7 }];
  assert.equal(lines[0].qty, 8);
  const order = await m.sp.createOrder({ id: 'ord-1', shopId: shop.id, supplierId: sup.id, lines });
  assert.equal(order.status, 'ordered');
  const text = m.sp.orderText(tFor('hi'), order.lines, await m.db.shops.get(shop.id), sup, 'hi');
  assert.equal(text, 'नमस्ते Sharma Traders जी, गुप्ता किराना से ऑर्डर:\n\n1. चीनी — 8 किलो\n2. नमक — 7 पैकेट\n\nधन्यवाद 🙏 — सुरेश');
  const link = m.waLink(text, sup.phone);
  assert.ok(link.startsWith('https://wa.me/919876543210?text='));
  assert.equal(decodeURIComponent(link.split('text=')[1]), text);
  assert.equal((await m.db.products.get(sugar.id)).qty, 2, 'ordering does not change stock');
  // Received: 6 kg sugar (less than ordered) and all salt; part cash.
  const today = m.dayKey(Date.now());
  const pur = await m.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: today, orderId: 'ord-1', lines: [{ productId: sugar.id, qty: 6, buyPrice: 41 }, { productId: salt.id, qty: 7, buyPrice: 20 }], paidCash: 100, paidUpi: 0 });
  assert.equal(pur.total, 386);
  assert.equal(pur.orderId, 'ord-1');
  const o2 = await m.db.orders.get('ord-1');
  assert.deepEqual([o2.status, o2.purchaseId], ['received', pur.id]);
  assert.equal((await m.db.products.get(sugar.id)).qty, 8);
  assert.equal((await m.db.products.get(salt.id)).qty, 8);
  await assert.rejects(m.sp.cancelOrder('ord-1'), code('status'));
  const o3 = await m.sp.createOrder({ shopId: shop.id, supplierId: sup.id, lines: [{ productId: oil.id, qty: 2 }] });
  assert.equal((await m.sp.cancelOrder(o3.id)).status, 'cancelled');
  const outbox = (await m.db.outbox.toArray()).filter((x) => x.table === 'purchase_orders' && x.rowId === 'ord-1');
  assert.equal(outbox.at(-1).payload.status, 'received', 'status change queued (last write wins)');
});

test('return to supplier / debit note and reasoned adjustments: append-only, balance derived, stock out via moves; CSV exports', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const { sugar } = await goods(m, shop);
  const sup = await m.sp.saveSupplier(shop.id, { name: 'मेहता', termsDays: 10 });
  const today = m.dayKey(Date.now());
  await m.sp.recordPurchase({ id: 'b1', shopId: shop.id, supplierId: sup.id, day: today, billNo: '55', lines: [{ productId: sugar.id, qty: 20, buyPrice: 40 }], paidCash: 0, paidUpi: 0 });
  // Returned 2 kg damaged.
  await assert.rejects(m.sp.returnToSupplier({ shopId: shop.id, supplierId: sup.id, lines: [{ productId: sugar.id, qty: 2, buyPrice: 40 }], reason: ' ' }), code('reason'));
  await new Promise((r) => setTimeout(r, 3));
  const ret = await m.sp.returnToSupplier({ shopId: shop.id, supplierId: sup.id, lines: [{ productId: sugar.id, qty: 2, buyPrice: 40 }], reason: 'पैकेट फटे' });
  assert.deepEqual([ret.type, ret.amount, ret.note], ['return', 80, 'चीनी ×2']);
  assert.equal((await m.db.products.get(sugar.id)).qty, 20);
  const mv = (await m.db.stockMoves.toArray()).find((x) => x.reason === 'supplierReturn');
  assert.deepEqual([mv.delta, mv.unitCost, mv.refId], [-2, 40, ret.id]);
  // Debit note without goods; adjustments both ways with reasons (a few ms apart: the CSV is in time order).
  const tick = () => new Promise((r) => setTimeout(r, 3));
  await tick();
  await m.sp.returnToSupplier({ shopId: shop.id, supplierId: sup.id, amount: 20, reason: 'रेट में छूट' });
  await tick();
  await m.sp.adjustSupplier({ shopId: shop.id, supplierId: sup.id, amount: 150, reason: 'डायरी से पहले का बाकी' });
  await tick();
  await m.sp.adjustSupplier({ shopId: shop.id, supplierId: sup.id, amount: -50, reason: 'गलती' });
  await assert.rejects(m.sp.adjustSupplier({ shopId: shop.id, supplierId: sup.id, amount: 10, reason: '' }), code('reason'));
  const led = await m.db.supplierLedger.toArray();
  assert.equal(m.sp.outstandingOf(led), 800 - 80 - 20 + 150 - 50);
  // Losses in the profit report are damage / theft only: a supplier return is credited, not a loss.
  const r = await m.rp.loadReport(shop.id, today, today);
  assert.equal(r.losses.total, 0);
  // CSV
  const sups = await m.db.suppliers.toArray();
  const rows = m.sp.supplierLedgerCSVRows(led, sups);
  assert.deepEqual(rows.map((x) => [x[3], x[5], x[6]]), [['purchase', 800, 800], ['return', -80, 720], ['return', -20, 700], ['adjust', 150, 850], ['adjust', -50, 800]]);
  assert.equal(m.sp.SUPPLIER_LEDGER_CSV_HEADERS.length, rows[0].length);
  const prow = m.sp.purchasesCSVRows(await m.db.purchases.toArray(), sups);
  assert.deepEqual(prow[0].slice(0, 8), [today, '55', 'मेहता', 'Sugar 20 kg @ 40', 800, 0, 0, 800]);
  const srows = m.sp.suppliersCSVRows(await m.sp.loadSupplierRows(shop.id, today));
  assert.deepEqual(srows[0].slice(0, 6), ['मेहता', undefined, undefined, 10, undefined, 800]);
  assert.equal(m.sp.SUPPLIERS_CSV_HEADERS.length, srows[0].length);
});

test('backup v4 carries the diary; v3 files restore and get supplier records from the free-text names; bad rows refused', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const { sugar } = await goods(m, shop);
  const sup = await m.sp.saveSupplier(shop.id, { name: 'Sharma', termsDays: 5 });
  await m.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: m.dayKey(Date.now()), lines: [{ productId: sugar.id, qty: 3, buyPrice: 41 }], paidCash: 23, paidUpi: 0 });
  await m.sp.createOrder({ shopId: shop.id, supplierId: sup.id, lines: [{ productId: sugar.id, qty: 4 }] });
  assert.equal(m.BACKUP_VERSION, 8); // v5 = repeat orders on top of the v4 diary, v6 = packs vs loose
  const file = await m.createBackup(shop.id);
  const parsed = JSON.parse(file.text);
  assert.equal(parsed.version, 8);
  assert.deepEqual([parsed.data.suppliers.length, parsed.data.purchases.length, parsed.data.supplierLedger.length, parsed.data.orders.length], [1, 1, 2, 1]);
  const { data, preview } = await m.readBackup(file.text);
  assert.deepEqual([preview.suppliers, preview.purchases, preview.supplierOwed], [1, 1, 100]);

  const B = loadPhone();
  await B.restoreBackup(data, 'owner-1');
  assert.equal(B.sp.outstandingOf(await B.db.supplierLedger.toArray()), 100);
  assert.equal((await B.db.orders.toArray())[0].status, 'ordered');

  // v3 file: no diary keys; a product with a typed supplier gets a record after restore.
  const v3 = JSON.parse(JSON.stringify(parsed.data));
  delete v3.suppliers; delete v3.purchases; delete v3.supplierLedger; delete v3.orders;
  v3.products = v3.products.map((p) => { const { supplierId, ...rest } = p; void supplierId; return p.id === sugar.id ? { ...rest, supplier: 'Old Wala' } : rest; });
  const C = loadPhone();
  const { data: d3 } = await C.readBackup(JSON.stringify(await fakeFile(C, v3, 3)));
  await C.restoreBackup(d3, 'owner-1');
  // The galla's supplier payment (made by the diary on the v4 phone) brings 'Sharma' back with its id.
  const cs = (await C.db.suppliers.toArray()).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(cs.map((s) => [s.id, s.name]), [[C.mig.supplierIdFor(shop.id, 'old wala'), 'Old Wala'], [sup.id, 'Sharma']]);
  assert.equal((await C.db.products.get(sugar.id)).supplierId, cs[0].id);

  // Validation: ledger row for an unknown supplier, adjust without reason, unpaid sum mismatch.
  for (const bad of [
    (d) => (d.supplierLedger[0].supplierId = 'nope'),
    (d) => d.supplierLedger.push({ ...d.supplierLedger[0], id: 'x', type: 'adjust', amount: 5, reason: undefined }),
    (d) => (d.purchases[0].credit = 1),
    (d) => (d.orders[0].status = 'lost'),
  ]) {
    const d = JSON.parse(JSON.stringify(parsed.data));
    bad(d);
    await assert.rejects(C.readBackup(JSON.stringify(await fakeFile(C, d, 4))), (e) => e.code === 'invalid');
  }
});

async function fakeFile(m, data, version) {
  const body = JSON.stringify(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const checksum = 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { format: m.BACKUP_FORMAT, version, exportedAt: Date.now(), shopId: data.shop.id, shopName: data.shop.name, checksum, data };
}

test('schema: every synced column exists in supabase/schema.sql; new tables have RLS, triggers and CHECKs; stock move reason allowed', () => {
  const m = loadPhone();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  for (const t of ['suppliers', 'purchases', 'supplier_ledger', 'purchase_orders']) {
    const body = sql.match(new RegExp(`create table if not exists ${t} \\(([\\s\\S]*?)\\n\\);`))[1];
    for (const c of m.SPECS[t].cols) assert.match(body, new RegExp(`\\n\\s+${m.snake(c)}\\s`), `${t}.${m.snake(c)}`);
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`));
    assert.ok(m.SYNC_ORDER.includes(t));
  }
  assert.ok(m.SYNC_ORDER.indexOf('suppliers') < m.SYNC_ORDER.indexOf('purchases'), 'suppliers pushed before their bills');
  assert.equal(m.SPECS.purchases.appendOnly, true);
  assert.equal(m.SPECS.supplier_ledger.appendOnly, true);
  assert.ok(!m.SPECS.suppliers.appendOnly && !m.SPECS.purchase_orders.appendOnly);
  assert.match(sql, /'purchase', 'supplierReturn'(, '[a-zA-Z]+')*\)\)/);
  assert.match(sql, /'suppliers', 'purchases', 'supplier_ledger', 'purchase_orders'[,\]]/);
  assert.match(sql, /'sales', 'suppliers', 'purchase_orders'[,\]]/, 'last-write-wins guard on edited tables');
  assert.match(sql, /create policy "own supplier ledger insert" on supplier_ledger for insert/);
  assert.doesNotMatch(sql, /create policy "own supplier ledger[^"]*" on supplier_ledger for (all|update|delete)/, 'ledger is insert-only');
  for (const c of ['supplier_id', 'reorder_to']) assert.match(sql, new RegExp(`alter table products add column if not exists ${c}`));
  // Round trip of a purchase through the column mapping.
  const p = { id: 'x', shopId: 's', supplierId: 'v', day: '2026-10-24', lines: [{ productId: 'a', qty: 1, buyPrice: 2, nameHi: 'अ', nameEn: 'a', unit: 'pcs' }], total: 2, paidCash: 0, paidUpi: 2, credit: 0, dueDate: '2026-10-30', createdAt: 1_700_000_000_000 };
  assert.deepEqual(m.fromRemote('purchases', m.toRemote('purchases', p, 'u')), p);
});

test('two phones through the mock Supabase: suppliers, bills, payments and orders add up; retries never duplicate', async () => {
  const mock = createMock();
  after(() => mock.close());
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const EMAIL = 'supplier@shop.test';
  const PASS = 'secret123';
  const A = loadPhone();
  const userA = await A.register(EMAIL, PASS);
  const shop = await makeShop(A, userA.id, crypto.randomUUID());
  const { sugar } = await goods(A, shop);
  const today = A.dayKey(Date.now());
  await A.cloudSignUp(EMAIL, PASS);
  assert.deepEqual(await A.linkShop(shop, userA.id), { status: 'linked' });
  const sup = await A.sp.saveSupplier(shop.id, { name: 'शर्मा', phone: '9876543210', termsDays: 7 });
  const order = await A.sp.createOrder({ shopId: shop.id, supplierId: sup.id, lines: [{ productId: sugar.id, qty: 10 }] });
  // The answer for the bills is lost after commit: the retry must not duplicate.
  mock.faults.push({ table: 'purchases', status: 503, afterCommit: true, times: 1 });
  await A.sp.recordPurchase({ shopId: shop.id, supplierId: sup.id, day: today, orderId: order.id, lines: [{ productId: sugar.id, qty: 10, buyPrice: 41 }], paidCash: 110, paidUpi: 0 });
  assert.ok((await A.syncNow()).error);
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(await A.pendingCount(shop.id), 0);
  assert.equal(mock.rows('purchases').length, 1);
  assert.equal(mock.rows('supplier_ledger').length, 2);
  assert.equal(mock.rows('purchase_orders')[0].status, 'received');

  // Phone B signs in: same balance, stock, galla.
  const B = loadPhone();
  await B.recoverFromCloud(EMAIL, PASS);
  const bal = async (m) => m.sp.outstandingOf(await m.db.supplierLedger.toArray());
  assert.equal(await bal(B), 300);
  assert.equal((await B.db.products.get(sugar.id)).qty, 12);
  assert.equal((await B.db.products.get(sugar.id)).buyPrice, 41);
  assert.equal((await B.loadCashDay(shop.id, today)).expected, -110);
  assert.equal((await B.db.orders.get(order.id)).status, 'received');

  // Both pay at the same time (A cash 100, B UPI 50) and B edits the supplier's terms.
  await A.sp.paySupplier({ shopId: shop.id, supplierId: sup.id, amount: 100, method: 'cash' });
  await B.sp.paySupplier({ shopId: shop.id, supplierId: sup.id, amount: 50, method: 'upi' });
  await B.sp.saveSupplier(shop.id, { name: 'शर्मा', phone: '9876543210', termsDays: 10 }, sup.id);
  for (const m of [A, B, A]) assert.equal((await m.syncNow()).error, undefined);
  assert.equal(await bal(A), 150);
  assert.equal(await bal(B), 150);
  assert.equal((await A.db.suppliers.get(sup.id)).termsDays, 10, 'edit arrives (last write wins)');
  assert.equal((await A.loadCashDay(shop.id, today)).expected, -210);
  assert.equal((await B.loadCashDay(shop.id, today)).expected, -210);

  // An older phone uploads a product with only a free-text supplier: the pull creates the record
  // with the name-based id (the same one that phone's own migration will make).
  const { createClient } = require('@supabase/supabase-js');
  const other = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, 'test-anon-key', { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: EMAIL, password: PASS });
  const uid = (await other.auth.getSession()).data.session.user.id;
  const t = Date.now();
  const legacy = { id: crypto.randomUUID(), shopId: shop.id, nameHi: 'घी', nameEn: 'Ghee', unit: 'ltr', qty: 0, buyPrice: 0, sellPrice: 600, lowStockAt: 1, salesCount: 0, supplier: 'Amul Agency', createdAt: t, updatedAt: t };
  assert.equal((await other.from('products').upsert([A.toRemote('products', legacy, uid)])).error, null);
  assert.equal((await A.syncNow()).error, undefined);
  const amul = A.mig.supplierIdFor(shop.id, 'Amul Agency');
  assert.equal((await A.db.suppliers.get(amul))?.name, 'Amul Agency');
  assert.equal(await A.pendingCount(shop.id), 0, 'created supplier uploaded in the same sync');
  assert.equal((await B.syncNow()).error, undefined);
  assert.equal(await B.db.suppliers.count(), 2, 'no duplicate on the other phone');
  assert.equal(mock.rows('suppliers').length, 2);
  // Insert-only on the server: an update of a ledger row is refused.
  const row = mock.rows('supplier_ledger')[0];
  const res = await other.from('supplier_ledger').upsert([{ ...row, amount: 1 }]).select('id');
  assert.ok(res.error, 'ledger rows cannot be overwritten');
});

test('i18n: supplier / purchase / order strings exist in Hindi and English with the same placeholders', () => {
  const hi = msgs('hi');
  const en = msgs('en');
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
  for (const ns of ['suppliers', 'purchase', 'order']) {
    assert.deepEqual(Object.keys(hi[ns]).sort(), Object.keys(en[ns]).sort(), ns);
    for (const k of Object.keys(hi[ns])) assert.equal(ph(hi[ns][k]), ph(en[ns][k]), `${ns}.${k}`);
  }
  for (const [ns, k] of [['home', 'chipSuppliers'], ['alerts', 'supTitle'], ['stock', 'reorderTo'], ['more', 'suppliersTitle'], ['report', 'exPurchases'], ['backup', 'previewSuppliers'], ['cash', 'supplierDiaryHint']]) {
    assert.ok(hi[ns][k] && en[ns][k], `${ns}.${k}`);
  }
  assert.ok(hi.adjust.move.supplierReturn && en.adjust.move.supplierReturn);
  for (const s of ['overdue', 'today', 'soon']) assert.ok(hi.suppliers[`badge_${s}`]);
  for (const c of ['name', 'duplicate', 'notFound', 'lines', 'qty', 'price', 'paid', 'amount', 'reason', 'future', 'terms', 'status']) assert.ok(hi.suppliers[`err_${c}`] && en.suppliers[`err_${c}`], c);
});
