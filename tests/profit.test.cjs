/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Honest profit: cost snapshot on every bill line, unknown buy prices never counted as cost 0
// (coverage instead), returns reversing their own cost, expenses + stock losses (at cost) for
// "earned after expenses", udhaar shown as not yet collected, owner withdrawals / supplier payments
// not expenses, adding a missing buy price (and filling older bills), migration of old lines,
// sync / schema / backup fields, ranges, WhatsApp text and CSV.
// Run: node tests/profit.test.cjs
process.env.TZ = 'Asia/Kolkata';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const Dexie = require('dexie').default ?? require('dexie');
const { createTranslator } = require('use-intl/core');
globalThis.WebSocket ??= class {};

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
    ...require('../src/lib/cash.ts'),
    ...require('../src/lib/stats.ts'),
    ...require('../src/lib/dates.ts'),
    ...require('../src/lib/syncSchema.ts'),
    ...require('../src/lib/backup.ts'),
    pf: require('../src/lib/profit.ts'),
    rp: require('../src/lib/report.ts'),
  };
}
const msgs = (l) => JSON.parse(fs.readFileSync(path.join(SRC, 'messages', `${l}.json`), 'utf8'));
const tFor = (l) => createTranslator({ locale: l, messages: msgs(l) });
const DAY = 86_400_000;
const SHOP = 'shop-1';

async function shopWith(m) {
  const now = Date.now();
  await m.db.shops.put({ id: SHOP, ownerId: 'u1', name: 'गुप्ता किराना', ownerName: 'सुरेश', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now });
  const sugar = await m.saveProduct(SHOP, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 50, sellPrice: 45, buyPrice: 40, lowStockAt: 5 });
  const salt = await m.saveProduct(SHOP, { nameHi: 'नमक', nameEn: 'Salt', unit: 'pkt', qty: 20, sellPrice: 28, buyPrice: 0, lowStockAt: 2 }); // starter item: no buy price yet
  const oil = await m.saveProduct(SHOP, { nameHi: 'तेल', nameEn: 'Oil', unit: 'ltr', qty: 10, sellPrice: 150, buyPrice: 140, lowStockAt: 2 });
  return { shop: await m.db.shops.get(SHOP), sugar, salt, oil };
}
const todayReport = (m) => {
  const d = m.dayKey(Date.now());
  return m.rp.loadReport(SHOP, d, d);
};

test('cost snapshot: each bill line keeps the buy price of that moment, or says "unknown" (never 0 = free)', async () => {
  const m = loadPhone();
  const { sugar, salt } = await shopWith(m);
  assert.ok(sugar.buyPriceAt > 0, 'buy price date recorded');
  assert.equal(salt.buyPriceAt, undefined, 'no buy price -> no date');
  const sale = await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: sugar, qty: 2 }, { product: salt, qty: 1 }] });
  assert.deepEqual(
    sale.items.map((i) => [i.nameEn, i.cost, i.costKnown, typeof i.costAt]),
    [['Sugar', 40, true, 'number'], ['Salt', 0, false, 'undefined']],
  );
  assert.equal(sale.items[0].costAt, sugar.buyPriceAt);
  // Price change later does not rewrite the old bill; an edit that keeps the buy price keeps its date.
  await new Promise((r) => setTimeout(r, 5));
  const renamed = await m.saveProduct(SHOP, { ...sugar, nameEn: 'Sugar (loose)' }, sugar.id);
  assert.equal(renamed.buyPriceAt, sugar.buyPriceAt, 'name edit keeps the buy-price date');
  const repriced = await m.saveProduct(SHOP, { ...renamed, buyPrice: 42 }, sugar.id);
  assert.ok(repriced.buyPriceAt > sugar.buyPriceAt, 'new buy price -> new date');
  assert.equal((await m.db.sales.get(sale.id)).items[0].cost, 40, 'old bill keeps its snapshot');
  const sale2 = await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: repriced, qty: 1 }] });
  assert.equal(sale2.items[0].cost, 42);
  // Snapshot helper directly.
  assert.deepEqual(m.pf.costSnapshot({ buyPrice: 0, updatedAt: 5, createdAt: 1 }), { cost: 0, costKnown: false });
  assert.deepEqual(m.pf.costSnapshot({ buyPrice: 10, updatedAt: 5, createdAt: 1 }), { cost: 10, costKnown: true, costAt: 5 }, 'old product: updatedAt is the best guess');
});

test('coverage: unknown-cost sales add no profit; home/bills stats and the report agree', async () => {
  const m = loadPhone();
  const { sugar, salt } = await shopWith(m);
  await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: sugar, qty: 2 }, { product: salt, qty: 1 }] }); // 90 known + 28 unknown
  const day = m.dayKey(Date.now());
  const sales = await m.db.sales.where('[shopId+day]').equals([SHOP, day]).toArray();
  const s = m.computeDayStats(sales, [], []);
  assert.equal(s.total, 118);
  assert.equal(s.profit, 10, 'only sugar: (45-40) x 2 — the old math said 38 (salt as 100% margin)');
  assert.equal(s.costCoverage, 76, 'floor(90/118) -> 76%, never rounded up');
  assert.equal(s.unknownCostSales, 28);
  const r = await todayReport(m);
  assert.deepEqual([r.netSales, r.knownSales, r.cogs, r.margin, r.unknownSales, r.complete], [118, 90, 80, 10, 28, false]);
  assert.equal(m.pf.coveragePct(r), 76);
  assert.deepEqual(r.missing.map((x) => [x.nameHi, x.qty, x.sales, x.exists]), [['नमक', 1, 28, true]]);
  assert.deepEqual(r.items.map((x) => [x.nameHi, x.margin, x.pct]), [['चीनी', 10, 11.1]]);
  // 99.6% stays 99, complete = 100
  assert.equal(m.pf.coveragePct({ coverage: 0.996, complete: false }), 99);
  assert.equal(m.pf.coveragePct({ coverage: 1, complete: true }), 100);
  // Nothing sold: complete, no warning.
  const empty = m.pf.marginTotals([], []);
  assert.deepEqual([empty.netSales, empty.coverage, empty.complete], [0, 1, true]);
});

test('returns reverse their own cost (known lines) or their unknown value; older bills resolved', async () => {
  const m = loadPhone();
  const { sugar, salt, oil } = await shopWith(m);
  const sale = await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: sugar, qty: 3 }, { product: salt, qty: 2 }, { product: oil, qty: 1 }] });
  // 135 (cost 120) + 56 unknown + 150 (cost 140) = 341
  let r = await todayReport(m);
  assert.deepEqual([r.netSales, r.knownSales, r.cogs, r.margin, r.unknownSales], [341, 285, 260, 25, 56]);
  const c = await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }, { index: 1, qty: 1 }], reason: 'वापस', refundMethod: 'cash' });
  assert.deepEqual(c.lines.map((l) => [l.cost, l.costKnown]), [[40, true], [0, false]], 'correction lines carry the cost status');
  r = await todayReport(m);
  assert.deepEqual([r.netSales, r.returns, r.knownSales, r.cogs, r.margin, r.unknownSales], [268, 73, 240, 220, 20, 28]);
  assert.deepEqual(r.items.find((i) => i.nameHi === 'चीनी').qty, 2);
  // Cancel the rest: everything nets to zero, coverage complete again.
  await m.correctSale({ saleId: sale.id, type: 'cancel', reason: 'रद्द', refundMethod: 'cash' });
  r = await todayReport(m);
  assert.deepEqual([r.netSales, r.margin, r.cogs, r.unknownSales, r.complete], [0, 0, 0, 0, true]);
  // A return today of an OLDER bill (not in today's sales): cost found via the bill.
  const old = { ...sale, id: 'old-bill', day: '2026-01-05', createdAt: Date.parse('2026-01-05T10:00:00+05:30'), status: undefined, returnedTotal: 0, returnedCost: 0, items: sale.items.map((i) => ({ ...i, returnedQty: 0 })) };
  await m.db.sales.put(old);
  await m.correctSale({ saleId: 'old-bill', type: 'return', lines: [{ index: 2, qty: 1 }], reason: 'old', refundMethod: 'cash' });
  const day = m.dayKey(Date.now());
  const st = m.computeDayStats(
    await m.db.sales.where('[shopId+day]').equals([SHOP, day]).toArray(),
    await m.db.corrections.where('[shopId+day]').equals([SHOP, day]).toArray(),
    [],
    new Map([['old-bill', await m.db.sales.get('old-bill')]]),
  );
  assert.equal(st.total, -150);
  assert.equal(st.profit, -10, 'the returned oil margin (150-140) comes off today');
});

test('expenses (galla categories) and damage/theft at cost give "earned after expenses"; withdrawals / supplier payments are not expenses', async () => {
  const m = loadPhone();
  const { sugar, salt, oil } = await shopWith(m);
  await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: oil, qty: 10 }] }); // margin 100
  const day = m.dayKey(Date.now());
  await m.addCashEntry({ shopId: SHOP, day, kind: 'expense', amount: 40, category: 'tea' });
  await m.addCashEntry({ shopId: SHOP, day, kind: 'expense', amount: 500, category: 'rent' });
  const wrong = await m.addCashEntry({ shopId: SHOP, day, kind: 'expense', amount: 999, category: 'repair' });
  await m.voidCashEntry({ entryId: wrong.id, reason: 'galti se' });
  await m.addCashEntry({ shopId: SHOP, day, kind: 'withdrawal', amount: 1000 });
  await m.addCashEntry({ shopId: SHOP, day, kind: 'supplier', amount: 2000, supplierName: 'Agarwal' });
  await m.addCashEntry({ shopId: SHOP, day, kind: 'bank', amount: 300 });
  const dmg = await m.recordStockAdjustment({ productId: sugar.id, reason: 'damage', qty: 2 });
  assert.equal(dmg.move.unitCost, 40, 'loss valued at the buy price of that moment');
  await m.recordStockAdjustment({ productId: salt.id, reason: 'theft', qty: 1 }); // no buy price: listed, not valued
  const cnt = await m.recordStockAdjustment({ productId: oil.id, reason: 'count', qty: 0 });
  assert.equal(cnt.move.unitCost, undefined, 'counts are not losses');
  // Buy price changes after the damage: the loss keeps its own value.
  await m.saveProduct(SHOP, { ...(await m.db.products.get(sugar.id)), buyPrice: 50 }, sugar.id);
  const r = await todayReport(m);
  assert.equal(r.margin, 100);
  assert.deepEqual(r.expenses, { total: 540, byCategory: { tea: 40, rent: 500 }, count: 2 }, 'voided expense left out');
  assert.equal(r.losses.total, 80);
  assert.equal(r.losses.unvalued, 1);
  assert.deepEqual(r.losses.rows.map((l) => [l.reason, l.qty, l.value]).sort(), [['damage', 2, 80], ['theft', 1, null]]);
  assert.equal(r.netEarned, 100 - 540 - 80);
  assert.deepEqual(r.notExpenses, { withdrawal: 1000, supplier: 2000, bank: 300 });
  // Old damage move without a saved cost: valued at today's buy price and marked as an estimate.
  await m.db.stockMoves.put({ id: 'legacy-dmg', shopId: SHOP, productId: oil.id, delta: -1, reason: 'damage', createdAt: Date.now() });
  const r2 = await todayReport(m);
  const leg = r2.losses.rows.find((l) => l.id === 'legacy-dmg');
  assert.deepEqual([leg.value, leg.estimated], [140, true]);
});

test('udhaar: margin earned but not collected; collected vs on credit; udhaar received is not profit', async () => {
  const m = loadPhone();
  const { oil, sugar } = await shopWith(m);
  await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: oil, qty: 1 }] }); // 150, margin 10
  const credit = await m.recordSale({ shopId: SHOP, payment: 'credit', newCustomer: { name: 'रामू' }, lines: [{ product: sugar, qty: 10 }] }); // 450 on udhaar, margin 50
  await m.recordSale({
    shopId: SHOP, payment: 'cash', lines: [{ product: oil, qty: 2 }],
    payments: [{ method: 'cash', amount: 200 }, { method: 'credit', amount: 100 }], customerId: credit.customerId,
  }); // split: 200 cash + 100 udhaar, margin 20
  await m.addLedger(SHOP, credit.customerId, 'credit', 120, 'पुराना', 'cash');
  const r = await todayReport(m);
  assert.equal(r.netSales, 900);
  assert.equal(r.margin, 80);
  assert.deepEqual([r.collected, r.cash, r.onCredit], [350, 350, 550]);
  assert.equal(r.marginOnCredit, Math.round((80 * 550) / 900 * 100) / 100);
  assert.equal(r.udhaarReceived, 120);
  assert.equal(r.netEarned, 80, 'udhaar received does not add to profit');
});

test('add a missing buy price: product updated, older lines filled (marked estimate) only when asked', async () => {
  const m = loadPhone();
  const { sugar, salt } = await shopWith(m);
  await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: sugar, qty: 1 }, { product: salt, qty: 2 }] });
  await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: salt, qty: 1 }] });
  assert.equal((await todayReport(m)).complete, false);
  await assert.rejects(m.setBuyPrice(salt.id, 0, true));
  // Without filling: only future bills.
  assert.equal(await m.setBuyPrice(salt.id, 22, false), 0);
  let p = await m.db.products.get(salt.id);
  assert.deepEqual([p.buyPrice, p.buyPriceAt > 0], [22, true]);
  let r = await todayReport(m);
  assert.equal(r.unknownSales, 84);
  assert.equal(r.missing[0].buyPriceNow, 22, 'the list offers to fill older bills');
  // Fill older bills.
  const outbox = await m.db.outbox.count();
  assert.equal(await m.setBuyPrice(salt.id, 22, true), 2);
  assert.ok((await m.db.outbox.count()) > outbox, 'filled bills queued for sync');
  r = await todayReport(m);
  assert.deepEqual([r.complete, r.unknownSales, r.margin, r.filledSales], [true, 0, 5 + 3 * 6, 84]);
  assert.deepEqual(r.items.find((i) => i.nameHi === 'नमक').flags, ['filled']);
  const bills = await m.db.sales.toArray();
  assert.ok(bills.every((b) => b.items.every((i) => i.costKnown)));
  assert.equal(bills.find((b) => b.items.length === 2).items[0].costFilled, undefined, 'known lines never rewritten');
  // Running it again changes nothing.
  assert.equal(await m.setBuyPrice(salt.id, 25, true), 0);
  assert.equal((await m.db.sales.toArray()).flatMap((b) => b.items).find((i) => i.nameHi === 'नमक').cost, 22);
});

test('flags: buy price above selling price, old buy price; top and low/negative-margin items', async () => {
  const m = loadPhone();
  const { sugar, oil } = await shopWith(m);
  const ghee = await m.saveProduct(SHOP, { nameHi: 'घी', nameEn: 'Ghee', unit: 'pcs', qty: 5, sellPrice: 500, buyPrice: 520, lowStockAt: 1 });
  await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: sugar, qty: 10 }, { product: oil, qty: 1 }, { product: ghee, qty: 1 }] });
  // An old buy price (entered 120 days before the sale).
  const t = Date.now();
  await m.db.sales.put({ id: 'stale', shopId: SHOP, items: [{ productId: oil.id, nameHi: 'तेल', nameEn: 'Oil', unit: 'ltr', qty: 1, price: 150, cost: 100, costKnown: true, costAt: t - 120 * DAY }], total: 150, cost: 100, payment: 'cash', payments: [{ method: 'cash', amount: 150, status: 'paid' }], createdAt: t, day: m.dayKey(t) });
  const r = await todayReport(m);
  assert.deepEqual(m.pf.topItems(r).map((i) => [i.nameHi, i.margin]), [['तेल', 60], ['चीनी', 50]]);
  // Sugar 11.1% and oil 20% are fine; ghee sells below its buy price.
  assert.deepEqual(m.pf.lowMarginItems(r).map((i) => [i.nameHi, i.pct]), [['घी', -4]]);
  const checks = Object.fromEntries(m.pf.costChecks(r).map((i) => [i.nameHi, i.flags]));
  assert.deepEqual(checks, { 'घी': ['aboveSell'], 'तेल': ['stale'] });
  assert.equal(m.pf.productCostFlag({ buyPrice: 0, sellPrice: 10 }, t), 'missing');
  assert.equal(m.pf.productCostFlag({ buyPrice: 11, sellPrice: 10, buyPriceAt: t }, t), 'aboveSell');
  assert.equal(m.pf.productCostFlag({ buyPrice: 9, sellPrice: 10, buyPriceAt: t - 91 * DAY }, t), 'stale');
  assert.equal(m.pf.productCostFlag({ buyPrice: 9, sellPrice: 10, buyPriceAt: t - 10 * DAY }, t), null);
});

test('migration: old bill / correction lines (no costKnown) with cost 0 are unknown, not free; nothing rewritten; v7 kept', async () => {
  const m = loadPhone();
  await shopWith(m);
  const t = Date.now();
  const day = m.dayKey(t);
  // Rows as an older version stored them (exact old shapes).
  const oldSale = { id: 'legacy', shopId: SHOP, items: [
    { productId: 'p-a', nameHi: 'साबुन', nameEn: 'Soap', unit: 'pcs', qty: 2, price: 30, cost: 25 },
    { productId: 'p-b', nameHi: 'बिस्कुट', nameEn: 'Biscuit', unit: 'pcs', qty: 4, price: 10, cost: 0 },
  ], total: 100, cost: 50, payment: 'cash', createdAt: t, day };
  await m.db.sales.put(oldSale);
  const oldCorr = { id: 'legacy-c', shopId: SHOP, saleId: 'legacy', type: 'return', reason: 'x', lines: [{ index: 1, productId: 'p-b', nameHi: 'बिस्कुट', nameEn: 'Biscuit', unit: 'pcs', qty: 1, price: 10, cost: 0 }], amount: 10, cost: 0, refundMethod: 'cash', createdAt: t, day };
  await m.db.corrections.put(oldCorr);
  assert.equal(m.pf.costKnown(oldSale.items[0]), true);
  assert.equal(m.pf.costKnown(oldSale.items[1]), false);
  assert.equal(m.pf.costKnown({ cost: 0, costKnown: true }), true, 'explicit flag wins');
  const r = await todayReport(m);
  assert.deepEqual([r.netSales, r.knownSales, r.cogs, r.margin, r.unknownSales], [90, 60, 50, 10, 30]);
  const st = m.computeDayStats([oldSale], [oldCorr], []);
  assert.equal(st.profit, 10, 'old math would have said 100-50-10 = 40');
  assert.equal(st.costCoverage, 66);
  // Stored rows are untouched by reading; the database version is unchanged (no forced rewrite).
  assert.deepEqual(await m.db.sales.get('legacy'), oldSale);
  assert.equal(m.db.verno, 10); // v8 / v9 = supplier diary and repeat-order tables, v10 = product kind only; sales rows are not rewritten
  // Backup: old files (no new fields) and new fields both validate; a wrong type is refused.
  const file = await m.createBackup(SHOP);
  const { data } = await m.readBackup(file.text);
  assert.deepEqual(data.sales.find((s) => s.id === 'legacy').items[1], oldSale.items[1]);
  const bad = JSON.parse(file.text);
  bad.data.sales.find((s) => s.id === 'legacy').items[0].costKnown = 'yes';
  bad.checksum = 'sha256:' + nodeCrypto.createHash('sha256').update(JSON.stringify(bad.data)).digest('hex');
  await assert.rejects(m.readBackup(JSON.stringify(bad)), (e) => e.code === 'invalid');
});

test('sync + schema: buy-price date and loss cost travel to the cloud; sale_items know cost_known', async () => {
  const m = loadPhone();
  const { sugar } = await shopWith(m);
  const remote = m.toRemote('products', sugar, 'owner');
  assert.equal(typeof remote.buy_price_at, 'string');
  assert.equal(m.fromRemote('products', remote).buyPriceAt, sugar.buyPriceAt);
  const { move } = await m.recordStockAdjustment({ productId: sugar.id, reason: 'theft', qty: 1 });
  const rm = m.toRemote('stock_moves', move, 'owner');
  assert.equal(rm.unit_cost, 40);
  assert.equal(m.fromRemote('stock_moves', { ...rm, unit_cost: '40.00' }).unitCost, 40);
  const sale = await m.recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: sugar, qty: 1 }] });
  assert.deepEqual(m.fromRemote('sales', m.toRemote('sales', sale, 'owner')).items, sale.items, 'line snapshot round-trips in items json');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(sql, /alter table products add column if not exists buy_price_at timestamptz/);
  assert.match(sql, /alter table stock_moves add column if not exists unit_cost numeric/);
  assert.match(sql, /alter table sale_items add column if not exists cost_known boolean/);
  assert.match(sql, /coalesce\(\(it ->> 'costKnown'\)::boolean, coalesce\(\(it ->> 'cost'\)::numeric, 0\) > 0\)/);
});

test('ranges (same presets / local IST days as bills), WhatsApp text, explanation lines and CSV; hi/en keys match', async () => {
  const m = loadPhone();
  const now = Date.parse('2026-10-22T23:30:00+05:30'); // Thursday, late evening IST
  assert.deepEqual(m.rp.reportRange('today', now), { preset: 'today', from: '2026-10-22', to: '2026-10-22' });
  assert.deepEqual(m.rp.reportRange('week', now), { preset: 'week', from: '2026-10-19', to: '2026-10-22' });
  assert.deepEqual(m.rp.reportRange('month', now), { preset: 'month', from: '2026-10-01', to: '2026-10-22' });
  assert.deepEqual(m.rp.customRange('2026-10-30', '2026-10-10', now), { preset: 'custom', from: '2026-10-10', to: '2026-10-22' }, 'ordered, no future');
  assert.equal(m.rp.customRange('nope', '', now), null);
  assert.deepEqual(m.rp.rangeFromParams('range=week', now).from, '2026-10-19');
  assert.deepEqual(m.rp.rangeFromParams('from=2026-10-05&to=2026-10-06', now), { preset: 'custom', from: '2026-10-05', to: '2026-10-06' });
  assert.equal(m.rp.rangeToParams({ preset: 'today', from: '', to: '' }), '');
  assert.equal(m.dayKey(Date.parse('2026-10-22T18:31:00Z')), '2026-10-23', 'midnight IST, not UTC');

  const { sugar, salt, shop } = await shopWith(m);
  await m.recordSale({ shopId: SHOP, payment: 'credit', newCustomer: { name: 'रामू' }, lines: [{ product: sugar, qty: 2 }, { product: salt, qty: 1 }] });
  await m.addCashEntry({ shopId: SHOP, day: m.dayKey(Date.now()), kind: 'withdrawal', amount: 500 });
  const r = await todayReport(m);
  const hi = tFor('hi');
  const lines = m.rp.explainLines(hi, r);
  assert.ok(lines.some((l) => l.includes('रक़म के 76% बिक्री')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('उधार पर गया')));
  assert.ok(lines.includes('मालिक ने निकाले ₹500 — ये खर्चे नहीं हैं, कमाई में नहीं घटाए।'), 'only the non-zero parts');
  assert.ok(lines.includes('बिक्री ₹118 हुई।'), 'no "₹0 returns" wording');
  assert.equal(hi('report.coverage', { pct: 82 }), 'रक़म के 82% बिक्री का मुनाफ़ा पता है');
  const wa = m.rp.reportText(hi, r, shop, m.rp.reportRange('today', Date.now()), 'hi');
  assert.match(wa, /गुप्ता किराना — हिसाब \(आज\)/);
  assert.match(wa, /कुल मुनाफ़ा: ₹10 \(रक़म के 76%/);
  assert.match(wa, /खरीद दाम नहीं पता/);
  const en = m.rp.explainLines(tFor('en'), r);
  assert.ok(en.some((l) => l.includes('Buy price known for 76% of sales')));
  const rows = m.rp.reportCSVRows(r);
  assert.equal(rows[0].length, m.rp.REPORT_CSV_HEADERS.length);
  assert.ok(rows.every((x) => x.length === m.rp.REPORT_CSV_HEADERS.length));
  assert.deepEqual(rows.find((x) => x[1] === 'gross_margin').slice(5, 6), [10]);
  assert.deepEqual(rows.find((x) => x[1] === 'owner_withdrawal').slice(5), [500, '', '', '', 'not an expense']);
  assert.ok(rows.some((x) => x[0] === 'no_buy_price' && x[1] === 'नमक'));
  // Every new key exists in both languages.
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, p + k + '.') : [p + k]));
  const H = keys(msgs('hi')).filter((k) => /^(report|home\.profit|bills\.profit|bills\.openReport|sales\.dayProfit|more\.report|stock\.buy)/.test(k)).sort();
  const E = keys(msgs('en')).filter((k) => /^(report|home\.profit|bills\.profit|bills\.openReport|sales\.dayProfit|more\.report|stock\.buy)/.test(k)).sort();
  assert.deepEqual(H, E);
  assert.ok(H.length > 90);
  // The report works offline: the service worker stores /hisaab (and its ?range= deep links).
  const vm = require('node:vm');
  const ctx = { self: { location: { origin: 'http://shop.test' }, addEventListener() {} }, URL, TextEncoder, crypto: globalThis.crypto, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8') + '\nthis.routeKey = routeKey;', ctx);
  assert.equal(ctx.routeKey(new URL('http://shop.test/hisaab?range=week').pathname), '/hisaab');
});
