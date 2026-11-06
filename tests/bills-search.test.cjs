/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Older bills + search (/sales): date presets and ranges on IST day boundaries, URL/session filter,
// payment / status filters, search (customer, phone, bill no., item, amount), the indexed query on
// ~5000 bills, returns on an older bill landing in today's drawer, CSV of the selection.
// Run: node tests/bills-search.test.cjs
process.env.TZ = 'Asia/Kolkata'; // the shop's phone is in India: days are IST calendar days
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const Dexie = require('dexie').default ?? require('dexie');
const { createTranslator } = require('use-intl/core');
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
    ...require('../src/lib/bills.ts'),
  };
}
const tHi = createTranslator({ locale: 'hi', messages: JSON.parse(fs.readFileSync(path.join(SRC, 'messages', 'hi.json'), 'utf8')) });

const SHOP = { name: 'शर्मा किराना', ownerName: 'रमेश', upiId: 'sharma@okbank', language: 'hi', deadStockDays: 30, expiryWarnDays: 7 };
async function makeShop(m, ownerId) {
  const now = Date.now();
  const shop = { ...SHOP, id: crypto.randomUUID(), ownerId, createdAt: now, updatedAt: now };
  await m.db.shops.add(shop);
  return shop;
}
const IST = (s) => new Date(s + '+05:30').getTime();
/** Run fn as if the phone's clock said `ms`. */
async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('presets and ranges follow IST calendar days (midnight, week from Monday, month start)', () => {
  const m = loadPhone();
  assert.equal(new Date(IST('2026-10-23T00:30:00')).getTimezoneOffset(), -330, 'running in IST');
  // 00:30 IST on 23 Oct is still 22 Oct in UTC: the shop's "today" is the 23rd.
  let now = IST('2026-10-23T00:30:00');
  assert.equal(new Date(now).toISOString().slice(0, 10), '2026-10-22');
  assert.deepEqual(m.presetRange('today', now), { from: '2026-10-23', to: '2026-10-23' });
  assert.deepEqual(m.presetRange('yesterday', now), { from: '2026-10-22', to: '2026-10-22' });
  assert.deepEqual(m.presetRange('week', now), { from: '2026-10-19', to: '2026-10-23' }, 'Monday 19 Oct');
  assert.deepEqual(m.presetRange('month', now), { from: '2026-10-01', to: '2026-10-23' });
  assert.deepEqual(m.presetRange('all', now), { from: m.ALL_FROM, to: '2026-10-23' });
  // 23:59 IST on 22 Oct is the 22nd; one minute later (00:00:30 on 23rd) is the 23rd.
  assert.equal(m.dayKey(IST('2026-10-22T23:59:59')), '2026-10-22');
  assert.equal(m.dayKey(IST('2026-10-23T00:00:30')), '2026-10-23');
  // Sunday still belongs to the week that started on Monday; Monday starts a new one; month rolls over.
  assert.deepEqual(m.presetRange('week', IST('2026-10-25T21:00:00')), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(m.presetRange('week', IST('2026-10-26T00:05:00')), { from: '2026-10-26', to: '2026-10-26' });
  assert.deepEqual(m.presetRange('month', IST('2026-11-01T00:10:00')), { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(m.presetRange('yesterday', IST('2026-03-01T08:00:00')), { from: '2026-02-28', to: '2026-02-28' });
  // Range in ms: IST midnight to IST midnight.
  const r = m.rangeMs('2026-10-22', '2026-10-23');
  assert.equal(new Date(r.start).toISOString(), '2026-10-21T18:30:00.000Z');
  assert.equal(new Date(r.end).toISOString(), '2026-10-23T18:29:59.999Z');
  now = IST('2026-10-23T10:00:00');
  assert.equal(m.presetOf('2026-10-22', '2026-10-22', now), 'yesterday');
  assert.equal(m.presetOf('2026-10-20', '2026-10-21', now), 'custom');
});

test('filter <-> URL query and session: presets by name, ranges checked, junk dropped', () => {
  const m = loadPhone();
  const now = IST('2026-10-23T10:00:00');
  assert.equal(m.filterFromParams('', now), null);
  assert.equal(m.filterToParams(m.defaultFilter(now)), '', 'plain /sales = today');
  const f = { ...m.defaultFilter(now), preset: 'yesterday', ...m.presetRange('yesterday', now), methods: ['cash', 'split'], statuses: ['returned'], q: 'राम', customerId: 'c-1' };
  const qs = m.filterToParams(f);
  assert.equal(qs, 'range=yesterday&pay=cash%2Csplit&status=returned&q=%E0%A4%B0%E0%A4%BE%E0%A4%AE&customer=c-1');
  assert.deepEqual(m.filterFromParams(qs, now), f);
  // A preset link opened tomorrow means tomorrow's yesterday.
  assert.deepEqual(m.filterFromParams('range=yesterday', IST('2026-10-24T09:00:00')).from, '2026-10-23');
  // Custom ranges: swapped, future clamped, invalid dates ignored, unknown values dropped.
  let g = m.filterFromParams('from=2026-10-20&to=2026-10-05&pay=cash,cheque&status=late,lost', now);
  assert.deepEqual([g.preset, g.from, g.to, g.methods, g.statuses], ['custom', '2026-10-05', '2026-10-20', ['cash'], ['late']]);
  g = m.filterFromParams('from=2026-10-20&to=2027-01-01', now);
  assert.deepEqual([g.from, g.to], ['2026-10-20', '2026-10-23']);
  g = m.filterFromParams('from=2026-02-30&to=2026-10-22', now);
  assert.deepEqual([g.preset, g.from, g.to], ['yesterday', '2026-10-22', '2026-10-22']);
  g = m.filterFromParams('customer=<script>&q=x', now);
  assert.equal(g.customerId, undefined);
  assert.equal(m.filterFromParams('from=2026-10-01&to=2026-10-23', now).preset, 'month');
});

test('search parsing: Hindi digits, ₹ amounts, bill numbers', () => {
  const m = loadPhone();
  assert.deepEqual(m.parseQuery(' ₹1,250 '), { text: '₹1,250', digits: '1250', amount: 1250, bill: null });
  assert.equal(m.parseQuery('१२०').amount, 120);
  assert.equal(m.parseQuery('98765').digits, '98765');
  assert.equal(m.parseQuery('#a1b2').bill, 'A1B2');
  assert.equal(m.parseQuery('चीनी').amount, null);
  assert.equal(m.billNo({ id: 'a1b2c3d4-0000-4000-8000-000000000000' }), 'A1B2C3');
});

test('filters + search + summary on a real shop; return on an older bill lands in today’s drawer', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-1');
  const NOW = IST('2026-10-23T11:00:00');
  const YDAY = IST('2026-10-22T23:58:00'); // 2 minutes before IST midnight
  const OLD = IST('2026-10-05T09:00:00');
  const oil = await at(OLD - 1000, () => m.saveProduct(shop.id, { nameHi: 'सरसों तेल', nameEn: 'Mustard oil', unit: 'pcs', qty: 100, sellPrice: 150, buyPrice: 130, lowStockAt: 1 }));
  const sugar = await at(OLD - 1000, () => m.saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 100, sellPrice: 45, buyPrice: 40, lowStockAt: 1 }));
  const ram = await at(OLD - 900, () => m.addCustomer(shop.id, 'रामलाल', '98765 43210'));
  const sita = await at(OLD - 900, () => m.addCustomer(shop.id, 'Sita Devi', '9123456789'));

  const old = await at(OLD, () => m.recordSale({ shopId: shop.id, payment: 'credit', lines: [{ product: oil, qty: 2 }], customerId: ram.id })); // ₹300 udhaar
  const y1 = await at(YDAY, () => m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: sugar, qty: 2 }], payments: [{ method: 'cash', amount: 90, tendered: 100 }] })); // ₹90
  const y2 = await at(YDAY + 30_000, () => m.recordSale({
    shopId: shop.id, payment: 'cash', lines: [{ product: oil, qty: 1 }], customerId: sita.id,
    payments: [{ method: 'cash', amount: 50 }, { method: 'upi', amount: 80, upi: 'paid' }, { method: 'credit', amount: 20 }],
  })); // ₹150 split (a customer is kept on a bill with udhaar), 23:58:30 IST → still the 22nd
  const after = await at(IST('2026-10-23T00:00:40'), () => m.recordSale({ shopId: shop.id, payment: 'upi', lines: [{ product: sugar, qty: 1 }], payments: [{ method: 'upi', amount: 45, upi: 'pending' }] }));
  assert.deepEqual([old.day, y1.day, y2.day, after.day], ['2026-10-05', '2026-10-22', '2026-10-22', '2026-10-23']);
  // Close yesterday's drawer, then a bill typed in late for yesterday is impossible via recordSale,
  // so a late bill is today's bill after today's close.
  await at(NOW, () => m.closeDay({ shopId: shop.id, day: '2026-10-23', counted: 0 }));
  const late = await at(NOW + 60_000, () => m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: sugar, qty: 3 }] })); // ₹135
  const cancelled = await at(NOW + 120_000, () => m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: sugar, qty: 1 }] }));
  await at(NOW + 130_000, () => m.correctSale({ saleId: cancelled.id, type: 'cancel', reason: 'गलत', refundMethod: 'cash' }));

  const q = (patch, now = NOW + 200_000) => at(now, () => {
    const base = m.defaultFilter(now);
    const preset = patch.preset ?? 'today';
    return m.queryBills(shop.id, { ...base, preset, ...(preset === 'custom' ? {} : m.presetRange(preset, now)), ...patch });
  });
  const ids = (r) => r.bills.map((s) => s.id);

  let r = await q({ preset: 'yesterday' });
  assert.deepEqual(ids(r), [y2.id, y1.id], 'newest first, both on the IST 22nd');
  assert.equal(r.stats.credit, 20);
  assert.deepEqual([r.stats.total, r.stats.cash, r.stats.upi, r.stats.count, r.stats.splitCount], [240, 140, 80, 2, 1]);
  r = await q({ preset: 'today' });
  assert.deepEqual(ids(r).sort(), [after.id, late.id, cancelled.id].sort());
  assert.deepEqual([r.stats.total, r.stats.upiPending, r.stats.returns, r.stats.count], [180, 45, 45, 2]);
  r = await q({ preset: 'month' });
  assert.equal(r.bills.length, 6);

  // Payment filters (any of).
  assert.deepEqual(ids(await q({ preset: 'month', methods: ['split'] })), [y2.id]);
  assert.deepEqual(ids(await q({ preset: 'month', methods: ['credit'] })), [y2.id, old.id]);
  assert.deepEqual(ids(await q({ preset: 'month', methods: ['upiPending'] })), [after.id]);
  assert.deepEqual(ids(await q({ preset: 'month', methods: ['upi'] })), [y2.id], 'pending UPI is not "UPI received"');
  assert.deepEqual(ids(await q({ preset: 'month', methods: ['upi', 'credit'] })), [y2.id, old.id]);
  // Status filters.
  assert.deepEqual(ids(await q({ preset: 'month', statuses: ['cancelled'] })), [cancelled.id]);
  assert.deepEqual(ids(await q({ preset: 'month', statuses: ['late'] })).sort(), [late.id, cancelled.id].sort(), 'bills after the drawer was closed');
  // Search: customer name (any case / part), phone digits with spaces, bill no., item (hi / en), amount.
  assert.deepEqual(ids(await q({ preset: 'all', q: 'राम' })), [old.id]);
  assert.deepEqual(ids(await q({ preset: 'all', q: 'sita' })), [y2.id]);
  assert.deepEqual(ids(await q({ preset: 'all', q: '43210' })), [old.id], 'phone stored with a space');
  assert.deepEqual(ids(await q({ preset: 'all', q: '#' + m.billNo(y1).toLowerCase() })), [y1.id]);
  assert.deepEqual(ids(await q({ preset: 'all', q: 'सरसों' })), [y2.id, old.id]);
  assert.deepEqual(ids(await q({ preset: 'all', q: 'SUGAR', statuses: ['active'] })).sort(), [late.id, after.id, y1.id].sort());
  assert.deepEqual(ids(await q({ preset: 'all', q: '₹300' })), [old.id]);
  assert.deepEqual(ids(await q({ preset: 'all', q: '१३५' })), [late.id], 'Hindi digits');
  // Customer view (udhaar → all their bills) uses the customerId index.
  assert.deepEqual(ids(await q({ preset: 'all', customerId: ram.id })), [old.id]);
  assert.deepEqual(ids(await q({ preset: 'today', customerId: ram.id })), []);

  // Return part of the 5 Oct bill today (in cash): today's summary and today's drawer show it; 5 Oct does not change.
  const before5 = (await q({ preset: 'custom', from: '2026-10-05', to: '2026-10-05' })).stats;
  const ret = await at(NOW + 300_000, () => m.correctSale({ saleId: old.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'खराब', refundMethod: 'cash', crossMethod: true }));
  assert.equal(ret.day, '2026-10-23');
  const after5 = (await q({ preset: 'custom', from: '2026-10-05', to: '2026-10-05' }, NOW + 400_000)).stats;
  assert.deepEqual(after5, before5, 'the old day is history');
  r = await q({ preset: 'today' }, NOW + 400_000);
  assert.equal(r.stats.returns, 45 + 150);
  const galla = await at(NOW + 400_000, () => m.loadCashDay(shop.id, '2026-10-23'));
  assert.equal(galla.cashOut.refunds, 45 + 150);
  assert.ok(galla.late.ids.has(ret.id), 'after closing: flagged late in the drawer');
  // Filtered summary only counts the matching bills' own returns inside the range.
  r = await q({ preset: 'month', customerId: ram.id }, NOW + 400_000);
  assert.deepEqual([r.stats.total, r.stats.returns, r.stats.count], [150, 150, 1]);
  assert.deepEqual(ids(await q({ preset: 'month', statuses: ['returned'] }, NOW + 400_000)), [old.id]);

  // CSV of the selection = the same rows as the More export, header length intact.
  r = await q({ preset: 'yesterday' });
  const rows = m.salesCSVRows(r.bills, (id) => (id === sita.id ? sita.name : undefined));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.length === m.SALES_CSV_HEADERS.length));
  assert.equal(rows[1][m.SALES_CSV_HEADERS.indexOf('customer')], 'Sita Devi');
  // WhatsApp bill text carries the bill number.
  assert.match(m.billText(tHi, y1, shop, 'hi'), new RegExp('बिल #' + m.billNo(y1)));
});

test('indexed queries stay fast with ~5000 bills', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-2');
  const other = await makeShop(m, 'owner-3');
  const NOW = IST('2026-10-23T18:00:00');
  const customers = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, shopId: shop.id, name: `ग्राहक ${i}`, phone: `98${String(i).padStart(8, '0')}`, balance: 0, createdAt: 0, updatedAt: 0 }));
  await m.db.customers.bulkAdd(customers);
  const N = 5000;
  const DAYS = 120;
  const items = [['चीनी', 'Sugar', 45], ['सरसों तेल', 'Mustard oil', 150], ['आटा', 'Atta', 38], ['साबुन', 'Soap', 30]];
  const sales = [];
  for (let i = 0; i < N; i++) {
    const createdAt = NOW - Math.floor((i / N) * DAYS * 86_400_000) - 60_000;
    const [nameHi, nameEn, price] = items[i % items.length];
    const qty = 1 + (i % 3);
    const total = price * qty;
    const kind = i % 5;
    const customerId = kind === 2 ? `c${i % 200}` : undefined;
    const payments = kind === 0 ? [{ method: 'cash', amount: total, status: 'paid' }]
      : kind === 1 ? [{ method: 'upi', amount: total, status: 'paid' }]
      : kind === 2 ? [{ method: 'credit', amount: total, status: 'paid' }]
      : kind === 3 ? [{ method: 'cash', amount: total - 10, status: 'paid' }, { method: 'upi', amount: 10, status: 'paid' }]
      : [{ method: 'upi', amount: total, status: 'pending' }];
    sales.push({
      id: crypto.randomUUID(), shopId: i % 50 === 49 ? other.id : shop.id, createdAt, day: m.dayKey(createdAt), total, cost: total - qty * 5,
      payment: payments.length > 1 ? 'split' : payments[0].method, payments, customerId,
      items: [{ productId: 'p' + (i % 4), nameHi, nameEn, unit: 'pcs', qty, price, cost: price - 5 }],
    });
  }
  await m.db.sales.bulkAdd(sales);
  assert.equal(await m.db.sales.count(), N);
  const run = async (patch) => {
    const t0 = performance.now();
    const r = await at(NOW, () => m.queryBills(shop.id, { ...m.defaultFilter(NOW), ...patch }));
    return { r, ms: performance.now() - t0 };
  };
  await run({}); // warm-up (transpile / first open)
  const today = await run({});
  const yday = await run({ preset: 'yesterday', ...m.presetRange('yesterday', NOW) });
  const month = await run({ preset: 'month', ...m.presetRange('month', NOW) });
  const cust = await run({ preset: 'all', ...m.presetRange('all', NOW), customerId: 'c7' });
  const all = await run({ preset: 'all', ...m.presetRange('all', NOW), q: 'चीनी', methods: ['split'] });
  // Full-table scan for comparison (what the screen would cost without the indexes).
  const t0 = performance.now();
  const scanned = (await m.db.sales.toArray()).filter((s) => s.shopId === shop.id && s.day === m.presetRange('yesterday', NOW).from);
  const scanMs = performance.now() - t0;
  const fmt = (x) => `${x.r.bills.length} bills ${x.ms.toFixed(0)} ms`;
  console.log(`# 5000 bills: today ${fmt(today)} · yesterday ${fmt(yday)} · month ${fmt(month)} · customer ${fmt(cust)} · all+search ${fmt(all)} · full scan ${scanMs.toFixed(0)} ms`);

  assert.ok(today.r.bills.length > 20 && today.r.bills.length < 60);
  assert.equal(yday.r.bills.length, scanned.length, 'index query = scan result');
  assert.ok(yday.r.bills.every((s) => s.shopId === shop.id), 'other shop never leaks in');
  assert.equal(cust.r.bills.length, sales.filter((s) => s.customerId === 'c7' && s.shopId === shop.id).length);
  assert.ok(all.r.bills.length > 0 && all.r.bills.every((s) => s.items[0].nameHi === 'चीनी' && s.payment === 'split'));
  assert.ok(m.db.sales.schema.idxByName.customerId, 'customerId index exists (v7)');
  // Timing: indexed day / customer queries read a few dozen rows and must beat a full scan by far.
  assert.ok(yday.ms < scanMs / 3, `yesterday via index (${yday.ms.toFixed(0)} ms) much faster than a full scan (${scanMs.toFixed(0)} ms)`);
  assert.ok(cust.ms < scanMs / 3, `customer via index (${cust.ms.toFixed(0)} ms) much faster than a full scan`);
  assert.ok(today.ms < 500 && yday.ms < 500 && cust.ms < 500, 'single-day / customer views well under half a second');
  assert.ok(all.ms < 10_000, 'even the all-time search finishes');
});

test('service worker serves /sales?… deep links (and /galla) from the cached route offline', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const ctx = { self: { location: { origin: 'http://shop.test' }, addEventListener() {} }, URL, TextEncoder, crypto: globalThis.crypto, console };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.routeKey = routeKey;', ctx);
  assert.equal(ctx.routeKey(new URL('http://shop.test/sales?range=yesterday&q=%E0%A4%B0').pathname), '/sales');
  assert.equal(ctx.routeKey('/sales/'), '/sales');
  assert.equal(ctx.routeKey('/udhaar'), '/udhaar');
});
