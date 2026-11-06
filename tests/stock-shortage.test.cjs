/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Stock discrepancies: selling more than recorded never blocks or clamps; the shortage is recorded
// in the stock history, shown as an alert, and fixed only by a reasoned correction. Also two phones
// overselling the same item at once, synced through the fake Supabase.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const Dexie = require('dexie').default ?? require('dexie');
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
/** A separate "phone": its own IndexedDB, its own copies of the app modules (session, cloud client). */
function loadPhone() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  Dexie.dependencies.indexedDB = new IDBFactory();
  return {
    ...require('../src/lib/db.ts'),
    ...require('../src/lib/ops.ts'),
    ...require('../src/lib/alerts.ts'),
    ...require('../src/lib/stats.ts'),
    ...require('../src/lib/auth.ts'),
    ...require('../src/lib/cloud.ts'),
    ...require('../src/lib/sync.ts'),
    ...require('../src/lib/backup.ts'),
    ...require('../src/lib/stockHistory.ts'),
  };
}

const SHOP = { name: 'वर्मा स्टोर', ownerName: 'सुरेश', language: 'hi', deadStockDays: 30, expiryWarnDays: 7 };
async function makeShop(m, ownerId) {
  const now = Date.now();
  const shop = { ...SHOP, id: crypto.randomUUID(), ownerId, createdAt: now, updatedAt: now };
  await m.db.transaction('rw', [m.db.shops, m.db.outbox], async () => {
    await m.db.shops.add(shop);
    await m.enqueue('shops', 'upsert', shop.id, shop);
  });
  return shop;
}
const sumMoves = async (m, productId) =>
  Math.round((await m.db.stockMoves.where('productId').equals(productId).toArray()).reduce((a, x) => a + x.delta, 0) * 100) / 100;

test('oversell -> negative stock -> return -> reasoned corrections (never clamped, never overwritten)', async () => {
  const m = loadPhone();
  const shop = await makeShop(m, 'owner-1');
  const sugar = await m.saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 2, sellPrice: 45, buyPrice: 40, lowStockAt: 1, expiryDate: '2020-01-01' });

  // 1. Sell 3 kg with only 2 on record: the sale goes through, stock shows -1, the move remembers the shortfall.
  const sale = await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: sugar, qty: 3 }] });
  assert.equal(sale.total, 135);
  let p = await m.db.products.get(sugar.id);
  assert.equal(p.qty, -1, 'not clamped to 0');
  const saleMove = (await m.db.stockMoves.where('productId').equals(sugar.id).toArray()).find((x) => x.reason === 'sale');
  assert.equal(saleMove.delta, -3, 'full quantity leaves stock');
  assert.equal(saleMove.shortBy, 1, 'shortage recorded in history');
  assert.equal(await sumMoves(m, sugar.id), p.qty);
  const outMove = (await m.db.outbox.toArray()).find((o) => o.rowId === saleMove.id);
  assert.equal(outMove.payload.shortBy, 1, 'the shortage syncs with the move');

  // Alerts: shortage (not low stock); expiry/dead-stock ignore items not on the shelf; profit unaffected.
  let a = m.computeAlerts([p], shop, Date.now());
  assert.deepEqual(a.shortage.map((x) => x.id), [sugar.id]);
  assert.equal(a.low.length, 0);
  assert.equal(a.expiring.length, 0);
  assert.equal(a.dead.length, 0);
  assert.equal(a.total, 1);
  assert.equal(m.computeDayStats([sale], [], []).profit, 15, 'profit = (45-40) x 3, stock level does not matter');

  // Recompute from history (what a pull does) keeps the negative number.
  await m.recomputeDerived(shop.id);
  assert.equal((await m.db.products.get(sugar.id)).qty, -1);

  // 2. Customer returns 1 kg: stock back to 0 (low stock, no shortage).
  await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'ज़्यादा ले गए', refundMethod: 'cash' });
  p = await m.db.products.get(sugar.id);
  assert.equal(p.qty, 0);
  a = m.computeAlerts([p], shop, Date.now());
  assert.equal(a.shortage.length, 0);
  assert.deepEqual(a.low.map((x) => x.id), [sugar.id]);

  // 3. Oversell again from 0: the whole sale is the shortfall.
  await m.recordSale({ shopId: shop.id, payment: 'upi', lines: [{ product: p, qty: 2 }] });
  const moves = await m.db.stockMoves.where('productId').equals(sugar.id).toArray();
  assert.equal(moves.filter((x) => x.reason === 'sale').map((x) => x.shortBy).sort().join(), '1,2');
  assert.equal((await m.db.products.get(sugar.id)).qty, -2);

  // Quick ± is not clamped either.
  await m.adjustStock(sugar.id, -0.5);
  assert.equal((await m.db.products.get(sugar.id)).qty, -2.5);
  await m.adjustStock(sugar.id, 0.5);

  // Editing product details (with a stale quantity in the form) never overwrites stock.
  const before = await m.db.stockMoves.count();
  await m.saveProduct(shop.id, { ...sugar, qty: 999, sellPrice: 46 }, sugar.id);
  p = await m.db.products.get(sugar.id);
  assert.equal(p.qty, -2);
  assert.equal(p.sellPrice, 46);
  assert.equal(await m.db.stockMoves.count(), before, 'no hidden move from a details edit');

  // 4. Reasoned corrections: physical count, purchase not entered, damage, theft.
  // (2 ms gaps between moves: same-millisecond moves have no defined order in the CSV)
  const tick = () => new Promise((r) => setTimeout(r, 2));
  await tick();
  const c = await m.recordStockAdjustment({ productId: sugar.id, reason: 'count', qty: 5, note: 'शाम की गिनती' });
  assert.equal(c.move.delta, 7);
  assert.equal(c.move.counted, 5);
  assert.equal(c.move.note, 'शाम की गिनती');
  await tick();
  await m.recordStockAdjustment({ productId: sugar.id, reason: 'purchase', qty: 10 });
  await tick();
  await m.recordStockAdjustment({ productId: sugar.id, reason: 'damage', qty: 1 });
  await tick();
  await m.recordStockAdjustment({ productId: sugar.id, reason: 'theft', qty: 0.5 });
  await tick();
  p = await m.db.products.get(sugar.id);
  assert.equal(p.qty, 13.5);
  const same = await m.recordStockAdjustment({ productId: sugar.id, reason: 'count', qty: 13.5 });
  assert.equal(same.move.delta, 0, 'a count that matches is still recorded');
  assert.equal(await sumMoves(m, sugar.id), 13.5);
  for (const bad of [{ reason: 'damage', qty: 0 }, { reason: 'count', qty: -1 }, { reason: 'theft', qty: NaN }, { reason: 'gift', qty: 1 }])
    await assert.rejects(m.recordStockAdjustment({ productId: sugar.id, ...bad }), m.StockError);
  assert.equal((await m.db.products.get(sugar.id)).qty, 13.5, 'refused corrections change nothing');

  // CSV export lists every move with reason, shortage, count and note.
  const rows = m.stockMovesCSVRows(await m.db.stockMoves.where('shopId').equals(shop.id).toArray(), [p]);
  const H = m.STOCK_MOVES_CSV_HEADERS;
  const col = (r, h) => r[H.indexOf(h)];
  assert.deepEqual(rows.map((r) => col(r, 'reason')), ['opening', 'sale', 'return', 'sale', 'adjust', 'adjust', 'count', 'purchase', 'damage', 'theft', 'count']);
  assert.deepEqual(rows.filter((r) => col(r, 'short_by') !== '').map((r) => col(r, 'short_by')), [1, 2]);
  assert.equal(col(rows[6], 'counted'), 5);
  assert.equal(col(rows[6], 'note'), 'शाम की गिनती');
  assert.equal(col(rows[8], 'value_at_buy_price'), -40);

  // Backups carry negative stock and the new move fields; restore is exact with no warnings.
  await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: p, qty: 20 }] });
  assert.equal((await m.db.products.get(sugar.id)).qty, -6.5);
  const { text } = await m.createBackup(shop.id);
  const { data, preview } = await m.readBackup(text);
  assert.deepEqual(preview.warnings, []);
  assert.equal(data.products[0].qty, -6.5);
  assert.ok(data.stockMoves.some((x) => x.reason === 'count' && x.counted === 5));
});

test('two phones oversell the same item at once: both end with the same negative stock, fixed by one count', async () => {
  const mock = createMock();
  after(() => mock.close());
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const EMAIL = 'verma@shop.test';
  const PASS = 'secret123';

  // Phone A: shop with 3 packets of Maggi, linked to the cloud.
  const A = loadPhone();
  const userA = await A.register(EMAIL, PASS);
  const shop = await makeShop(A, userA.id);
  const maggi = await A.saveProduct(shop.id, { nameHi: 'मैगी', nameEn: 'Maggi', unit: 'pcs', qty: 3, sellPrice: 14, buyPrice: 12, lowStockAt: 2 });
  await A.cloudSignUp(EMAIL, PASS);
  assert.deepEqual(await A.linkShop(shop, userA.id), { status: 'linked' });

  // Phone B: the shop's second phone, restored from the cloud.
  const B = loadPhone();
  await B.recoverFromCloud(EMAIL, PASS);
  assert.equal((await B.db.products.get(maggi.id)).qty, 3);

  // Both sell 2 packets while offline (each sees 3 on record, so neither sees a shortage yet).
  const saleA = await A.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: await A.db.products.get(maggi.id), qty: 2 }] });
  const saleB = await B.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: await B.db.products.get(maggi.id), qty: 2 }] });
  assert.equal((await A.db.products.get(maggi.id)).qty, 1);
  assert.equal((await B.db.products.get(maggi.id)).qty, 1);

  // A's upload of the moves is committed but the reply is lost; the retry must not duplicate.
  mock.faults.push({ table: 'stock_moves', status: 503, afterCommit: true, times: 1 });
  let r = await A.syncNow();
  assert.ok(r.error, 'lost reply is reported, not hidden');
  assert.ok((await A.pendingCount(shop.id)) > 0);
  r = await A.syncNow();
  assert.equal(r.error, undefined);
  r = await B.syncNow();
  assert.equal(r.error, undefined);
  r = await A.syncNow(); // A pulls B's sale
  assert.equal(r.error, undefined);

  for (const [name, phone] of [['A', A], ['B', B]]) {
    const p = await phone.db.products.get(maggi.id);
    assert.equal(p.qty, -1, `phone ${name}: 3 - 2 - 2 = -1, not clamped`);
    const al = phone.computeAlerts(await phone.db.products.where('shopId').equals(shop.id).toArray(), await phone.db.shops.get(shop.id), Date.now());
    assert.deepEqual(al.shortage.map((x) => x.id), [maggi.id], `phone ${name} shows the shortage`);
    assert.equal(await phone.pendingCount(shop.id), 0);
    assert.ok(await phone.db.sales.get(saleA.id));
    assert.ok(await phone.db.sales.get(saleB.id));
  }
  const server = mock.rows('stock_moves').filter((x) => x.product_id === maggi.id);
  assert.equal(new Set(server.map((x) => x.id)).size, server.length, 'no duplicate moves on the server');
  assert.equal(server.reduce((a, x) => a + Number(x.delta), 0), -1);

  // A counts the shelf (0 packets): one reasoned correction fixes both phones.
  await A.recordStockAdjustment({ productId: maggi.id, reason: 'count', qty: 0, note: 'गिनती' });
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal((await B.syncNow()).error, undefined);
  for (const phone of [A, B]) assert.equal((await phone.db.products.get(maggi.id)).qty, 0);
  const count = mock.rows('stock_moves').find((x) => x.reason === 'count');
  assert.equal(Number(count.delta), 1);
  assert.equal(Number(count.counted), 0);
  assert.equal(count.note, 'गिनती');

  // The server rejects an unknown reason (schema CHECK), so bad history cannot sneak in.
  const { createClient } = require('@supabase/supabase-js');
  const other = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, 'test-anon-key', { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: EMAIL, password: PASS });
  const uid = (await other.auth.getSession()).data.session.user.id;
  const { toRemote } = require('../src/lib/syncSchema.ts');
  const bad = await other.from('stock_moves').insert([toRemote('stock_moves', { id: crypto.randomUUID(), shopId: shop.id, productId: maggi.id, delta: 5, reason: 'gift', createdAt: Date.now() }, uid)]);
  assert.equal(bad.error?.code, '23514');
});
