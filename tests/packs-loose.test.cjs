/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Sealed packs vs loose goods + "₹20 का सामान" (item 14): kind from unit (Dexie v10 migration keeps
// stock / prices), type rules on save, opening packs into loose stock (two "openPack" moves, never
// blocking), amount -> qty rounding with an exact line total, returns of amount lines, voice / pasted
// money ("20 rupaye ki chini", "₹20 का तेल", "50 ka atta"), orders / baskets / repeat with amounts,
// reorder and purchases in whole units, CSV, backup v6 (+ v5 files), schema / sync columns, two phones.
// Run: node tests/packs-loose.test.cjs
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
    ...require('../src/lib/auth.ts'),
    ...require('../src/lib/cloud.ts'),
    ...require('../src/lib/sync.ts'),
    ...require('../src/lib/backup.ts'),
    ...require('../src/lib/syncSchema.ts'),
    ...require('../src/lib/bills.ts'),
    ...require('../src/lib/profit.ts'),
    u: require('../src/lib/units.ts'),
    vp: require('../src/lib/voiceParse.ts'),
    or: require('../src/lib/orders.ts'),
    sp: require('../src/lib/suppliers.ts'),
    share: require('../src/lib/share.ts'),
  };
}
const msgs = (l) => JSON.parse(fs.readFileSync(path.join(SRC, 'messages', `${l}.json`), 'utf8'));
const tFor = (l) => createTranslator({ locale: l, messages: msgs(l) });
const code = (c) => (e) => e.code === c;

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
  const sugar = await m.saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 10, sellPrice: 45, buyPrice: 40, lowStockAt: 5 });
  const oil = await m.saveProduct(shop.id, { nameHi: 'सरसों तेल', nameEn: 'Mustard Oil', unit: 'ltr', qty: 20, sellPrice: 150, buyPrice: 140, lowStockAt: 2 });
  const atta = await m.saveProduct(shop.id, { nameHi: 'खुला आटा', nameEn: 'Loose Atta', unit: 'kg', qty: 2.5, sellPrice: 40, buyPrice: 34, lowStockAt: 5, kind: 'loose', step: 0.25 });
  const attaPack = await m.saveProduct(shop.id, { nameHi: 'आशीर्वाद आटा 1 किलो', nameEn: 'Aashirvaad Atta 1kg', unit: 'pkt', qty: 3, sellPrice: 55, buyPrice: 48, lowStockAt: 2, kind: 'packed', mrp: 60, looseId: atta.id, packSize: 1 });
  const maggi = await m.saveProduct(shop.id, { nameHi: 'मैगी', nameEn: 'Maggi', unit: 'pkt', qty: 10, sellPrice: 14, buyPrice: 12, lowStockAt: 5 });
  return { sugar, oil, atta, attaPack, maggi };
}
/** A product row as saveProduct input (edit form). */
const inputOf = (p) => {
  const x = { ...p };
  for (const k of ['id', 'shopId', 'createdAt', 'updatedAt', 'salesCount', 'lastSoldAt']) delete x[k];
  return x;
};
const moveSum = async (m, id) => Math.round((await m.db.stockMoves.where('productId').equals(id).toArray()).reduce((a, x) => a + x.delta, 0) * 100) / 100;

/* ------------------------------------------------------------------ */

test('units: kind from unit, steps, valid quantities, amount -> qty (10 g) with an exact total, cumulative part values, formatting', () => {
  const { u } = loadPhone();
  assert.deepEqual(['kg', 'ltr', 'pcs', 'pkt', 'box'].map(u.kindForUnit), ['loose', 'loose', 'packed', 'packed', 'packed']);
  assert.equal(u.kindOf({ unit: 'kg' }), 'loose');
  assert.equal(u.stepOf({ unit: 'kg' }), 1, 'default step is 1 kg (no more 0.5 kg per tap)');
  assert.equal(u.stepOf({ unit: 'kg', step: 0.25 }), 0.25);
  assert.equal(u.stepOf({ unit: 'pkt', step: 0.25 }), 1, 'packs always step by 1');
  assert.equal(u.validQtyFor(0.44, 'kg'), true);
  assert.equal(u.validQtyFor(0.445, 'kg'), false);
  assert.equal(u.validQtyFor(2, 'pkt'), true);
  assert.equal(u.validQtyFor(1.5, 'pkt'), false);
  // ₹20 of ₹45/kg chini = 0.444… kg -> 440 g; ₹20 of ₹150/L oil = 0.1333 L -> 130 ml.
  assert.equal(u.qtyForAmount(20, { unit: 'kg', sellPrice: 45 }), 0.44);
  assert.equal(u.qtyForAmount(20, { unit: 'ltr', sellPrice: 150 }), 0.13);
  assert.equal(u.qtyForAmount(50, { unit: 'kg', sellPrice: 40 }), 1.25);
  assert.equal(u.qtyForAmount(10, { unit: 'kg', sellPrice: 45 }), 0.22);
  assert.equal(u.qtyForAmount(20, { unit: 'pkt', sellPrice: 10 }), null, 'packs are not sold by amount');
  assert.equal(u.qtyForAmount(0.2, { unit: 'kg', sellPrice: 45 }), null, 'less than 10 g');
  assert.equal(u.qtyForAmount(20, { unit: 'kg', sellPrice: 0 }), null);
  // The amount is the anchor: line total = amount exactly, not qty × price (0.44 × 45 = 19.80).
  assert.equal(u.lineTotal({ qty: 0.44, price: 45, amount: 20 }), 20);
  assert.equal(u.lineTotal({ qty: 0.44, price: 45 }), 19.8);
  const line = { qty: 0.44, price: 45, amount: 20 };
  const a = u.partValue(line, 0.2, 0);
  const b = u.partValue(line, 0.24, 0.2);
  assert.equal(a, 9.09);
  assert.equal(Math.round((a + b) * 100) / 100, 20, 'part returns add up to exactly the amount');
  assert.equal(u.partValue(line, 0.44, 0), 20);
  assert.equal(u.partValue({ qty: 2, price: 14 }, 1), 14);
  const hi = tFor('hi');
  const en = tFor('en');
  assert.equal(u.fmtQty(hi, 0.44, 'kg'), '440 ग्राम');
  assert.equal(u.fmtQty(en, 0.13, 'ltr'), '130 ml');
  assert.equal(u.fmtQty(en, 1.5, 'kg'), '1.5 kg');
  assert.equal(u.fmtQty(hi, 2, 'pkt'), '2 पैकेट');
  assert.equal(hi('picker.result', { amount: '₹20', qty: u.fmtQty(hi, 0.44, 'kg') }), '₹20 = 440 ग्राम');
  assert.equal(u.parseLooseInput('250', true), 0.25);
  assert.equal(u.parseLooseInput('१.५', false), 1.5);
  assert.equal(u.parseLooseInput('255', true), null, '5 g steps are below the 10 g precision');
  assert.equal(u.parseLooseInput('0', true), null);
});

test('Dexie v9 -> v10: every product gets its kind from its unit; stock, prices, updatedAt and the queue untouched', async () => {
  // The v9 layout, read from the current schema (v10 adds no tables / indexes).
  const probe = loadPhone();
  await probe.db.open();
  const stores = Object.fromEntries(probe.db.tables.map((t) => {
    const pk = t.schema.primKey;
    const idx = t.schema.indexes.map((i) => (i.unique ? '&' : '') + (i.multi ? '*' : '') + i.src);
    return [t.name, [(pk.auto ? '++' : '') + pk.src, ...idx].join(', ')];
  }));
  probe.db.close();
  const factory = new IDBFactory();
  Dexie.dependencies.indexedDB = factory;
  const old = new Dexie('dukaanmitra');
  old.version(9).stores(stores);
  await old.open();
  const t = 1_760_000_000_000;
  await old.table('products').bulkAdd([
    { id: 'p1', shopId: 's1', nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 7.45, buyPrice: 40, sellPrice: 45, lowStockAt: 1, salesCount: 3, createdAt: t, updatedAt: t },
    { id: 'p2', shopId: 's1', nameHi: 'तेल', nameEn: 'Oil', unit: 'ltr', qty: 2.5, buyPrice: 140, sellPrice: 150, lowStockAt: 1, salesCount: 0, createdAt: t, updatedAt: t },
    { id: 'p3', shopId: 's1', nameHi: 'मैगी', nameEn: 'Maggi', unit: 'pkt', qty: -2, buyPrice: 12, sellPrice: 14, lowStockAt: 5, salesCount: 0, createdAt: t, updatedAt: t },
    { id: 'p4', shopId: 's1', nameHi: 'साबुन', nameEn: 'Soap', unit: 'pcs', qty: 4, buyPrice: 28, sellPrice: 32, lowStockAt: 5, salesCount: 0, createdAt: t, updatedAt: t },
    { id: 'p5', shopId: 's1', nameHi: 'डिब्बा', nameEn: 'Box', unit: 'box', qty: 1, buyPrice: 100, sellPrice: 120, lowStockAt: 1, salesCount: 0, createdAt: t, updatedAt: t },
  ]);
  old.close();
  const m = loadPhone(factory);
  await m.db.open();
  assert.equal(m.db.verno, 10);
  const rows = await m.db.products.orderBy('id').toArray();
  assert.deepEqual(rows.map((p) => [p.id, p.kind, p.qty, p.sellPrice, p.buyPrice, p.updatedAt]), [
    ['p1', 'loose', 7.45, 45, 40, t],
    ['p2', 'loose', 2.5, 150, 140, t],
    ['p3', 'packed', -2, 14, 12, t],
    ['p4', 'packed', 4, 32, 28, t],
    ['p5', 'packed', 1, 120, 100, t],
  ]);
  assert.equal(await m.db.outbox.count(), 0, 'nothing queued: other phones derive the same kind');
  assert.ok(rows.every((p) => p.step === undefined && p.mrp === undefined), 'no other field invented');
});

test('saving products: kind matches unit, packs have whole stock, loose step / packed MRP + pack link validated', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  assert.equal(g.sugar.kind, 'loose', 'callers without kind get the unit\'s kind');
  assert.equal(g.maggi.kind, 'packed');
  assert.equal(g.atta.step, 0.25);
  assert.deepEqual([g.attaPack.mrp, g.attaPack.looseId, g.attaPack.packSize], [60, g.atta.id, 1]);
  const base = { nameHi: 'x', nameEn: 'x', qty: 1, sellPrice: 10, buyPrice: 0, lowStockAt: 0 };
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'pkt', kind: 'loose' }), code('unit'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'kg', kind: 'packed' }), code('unit'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'pkt', qty: 2.5 }), code('packQty'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'kg', step: 0.333 }), code('step'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'pkt', mrp: -1 }), code('mrp'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'pkt', looseId: g.maggi.id, packSize: 1 }), code('packLink'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'pkt', looseId: g.atta.id, packSize: 0 }), code('packSize'));
  await assert.rejects(m.saveProduct(shop.id, { ...base, unit: 'pkt', looseId: g.atta.id, packSize: 0.333 }), code('packSize'));
  // Loose items never keep an MRP or a pack link; packs never keep a step.
  const l = await m.saveProduct(shop.id, { ...base, unit: 'kg', mrp: 50, looseId: g.atta.id, packSize: 1, step: 0.5 });
  assert.deepEqual([l.kind, l.mrp, l.looseId, l.packSize, l.step], ['loose', undefined, undefined, undefined, 0.5]);
  const p = await m.saveProduct(shop.id, { ...base, unit: 'pcs', step: 0.5 });
  assert.equal(p.step, undefined);
  // A loose item with 7.5 kg on record can't become a pack (stock is never changed by an edit).
  const row1 = await m.db.products.get(g.sugar.id);
  const id = row1.id;
  const input = inputOf(row1);
  await m.adjustStock(id, -2.5);
  await assert.rejects(m.saveProduct(shop.id, { ...input, unit: 'pkt', kind: 'packed' }, id), code('packQty'));
  const before = await m.db.products.get(id);
  const edited = await m.saveProduct(shop.id, { ...input, sellPrice: 46, step: 0.1 }, id);
  assert.deepEqual([edited.qty, edited.sellPrice, edited.step], [before.qty, 46, 0.1]);
});

test('open pack: −packs on the sealed product, +packs×size on the loose one (same refId, reason openPack); never blocks; stock = moves', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const r = await m.openPack({ productId: g.attaPack.id, packs: 2, note: ' खुला बेचने ' });
  assert.deepEqual([r.pack.qty, r.loose.qty], [1, 4.5]);
  assert.deepEqual([r.out.delta, r.into.delta, r.out.reason, r.into.reason], [-2, 2, 'openPack', 'openPack']);
  assert.equal(r.out.refId, r.into.refId);
  assert.equal(r.out.note, 'खुला बेचने');
  assert.equal(r.out.shortBy, undefined);
  // More than on record: recorded with the shortage, stock goes negative (item-4 rule).
  const s = await m.openPack({ productId: g.attaPack.id, packs: 3 });
  assert.deepEqual([s.pack.qty, s.out.shortBy, s.loose.qty], [-2, 2, 7.5]);
  for (const id of [g.attaPack.id, g.atta.id]) assert.equal(await moveSum(m, id), (await m.db.products.get(id)).qty, 'stock = sum of moves');
  await m.recomputeDerived(shop.id);
  assert.deepEqual([(await m.db.products.get(g.attaPack.id)).qty, (await m.db.products.get(g.atta.id)).qty], [-2, 7.5]);
  const q = (await m.db.outbox.toArray()).filter((o) => o.table === 'stock_moves' && o.payload.reason === 'openPack');
  assert.equal(q.length, 4, 'both moves of both openings are queued for sync');
  await assert.rejects(m.openPack({ productId: g.attaPack.id, packs: 1.5 }), code('qty'));
  await assert.rejects(m.openPack({ productId: g.attaPack.id, packs: 0 }), code('qty'));
  await assert.rejects(m.openPack({ productId: g.maggi.id, packs: 1 }), code('notFound'), 'not linked');
  await assert.rejects(m.openPack({ productId: g.atta.id, packs: 1 }), code('notFound'), 'loose items are not packs');
  assert.ok(msgs('hi').adjust.move.openPack && msgs('en').adjust.move.openPack);
});

test('sell by amount: qty derived (10 g), line total = amount exactly, cost + stock use the derived qty; packs refuse amounts', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const sale = await m.recordSale({
    shopId: shop.id,
    lines: [{ product: g.sugar, qty: 999, amount: 20 }, { product: g.oil, qty: 0, amount: 20 }, { product: g.maggi, qty: 2 }, { product: g.atta, qty: 0.25 }],
    payment: 'cash',
  });
  const [chini, tel, maggi, atta] = sale.items;
  assert.deepEqual([chini.qty, chini.amount, chini.price], [0.44, 20, 45]);
  assert.deepEqual([tel.qty, tel.amount], [0.13, 20]);
  assert.equal(maggi.amount, undefined);
  assert.equal(atta.amount, undefined);
  assert.equal(sale.total, 20 + 20 + 28 + 10, 'amount lines count exactly what was asked');
  assert.equal(sale.cost, Math.round((0.44 * 40 + 0.13 * 140 + 2 * 12 + 0.25 * 34) * 100) / 100, 'cost snapshot on the derived qty');
  assert.equal((await m.db.products.get(g.sugar.id)).qty, 9.56);
  assert.equal((await m.db.products.get(g.oil.id)).qty, 19.87);
  assert.equal(sale.payments[0].amount, 78);
  await assert.rejects(m.recordSale({ shopId: shop.id, lines: [{ product: g.maggi, qty: 1, amount: 20 }], payment: 'cash' }), code('amount'));
  await assert.rejects(m.recordSale({ shopId: shop.id, lines: [{ product: g.maggi, qty: 1.5 }], payment: 'cash' }), code('qty'));
  await assert.rejects(m.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 0.255 }], payment: 'cash' }), code('qty'));
  await assert.rejects(m.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 1, amount: 0.1 }], payment: 'cash' }), code('amount'));
  // WhatsApp bill + profit read the amount.
  const text = m.share.billText(tFor('hi'), sale, shop, 'hi');
  assert.match(text, /चीनी.*₹20/);
  const mt = m.marginTotals([sale], []);
  assert.equal(mt.netSales, 78);
  // CSV marks the amount lines.
  const row = m.salesCSVRows([sale], () => '')[0];
  assert.match(String(row[3]), /Sugar x0\.44 kg \(Rs 20\)/);
  assert.match(String(row[3]), /Maggi x2(;|$)/);
});

test('returns of amount lines: valued pro rata, parts add up to the amount; full cancel gives back the bill total', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const sale = await m.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 0, amount: 20 }, { product: g.maggi, qty: 2 }], payment: 'cash' });
  const c1 = await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 0.2 }], reason: 'थोड़ा वापस', refundMethod: 'cash' });
  assert.equal(c1.amount, 9.09);
  assert.equal(c1.lines[0].amount, 9.09);
  const c2 = await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 0.24 }, { index: 1, qty: 1 }], reason: 'बाकी वापस', refundMethod: 'cash' });
  assert.equal(c2.lines[0].amount, 10.91);
  assert.equal(c2.amount, 10.91 + 14);
  const s = await m.db.sales.get(sale.id);
  assert.equal(s.returnedTotal, 20 + 14, 'the whole ₹20 came back, not 0.44 × 45');
  assert.equal((await m.db.products.get(g.sugar.id)).qty, 10, 'stock back by the derived qty');
  const mt = m.marginTotals([s], [c1, c2], new Map([[s.id, s]]));
  assert.equal(mt.netSales, 14);
  // A cancel of a fresh amount bill returns exactly its total.
  const s2 = await m.recordSale({ shopId: shop.id, lines: [{ product: g.oil, qty: 0, amount: 50 }], payment: 'cash' });
  const c3 = await m.correctSale({ saleId: s2.id, type: 'cancel', reason: 'गलत बिल', refundMethod: 'cash' });
  assert.equal(c3.amount, 50);
});

test('voice / pasted money: "20 rupaye ki chini", "₹20 का तेल", "50 ka atta"; packs get 1 (flagged); quantities still parsed', async () => {
  const m = loadPhone();
  const P = m.vp.parseSpokenQuantity;
  assert.deepEqual(P('20 rupaye ki chini'), { qty: null, unit: null, rest: 'chini', money: true, amount: 20 });
  assert.deepEqual(P('₹20 का तेल'), { qty: null, unit: null, rest: 'तेल', money: true, amount: 20 });
  assert.deepEqual(P('50 ka atta'), { qty: null, unit: null, rest: 'atta', money: true, amount: 50 });
  assert.equal(P('Rs.30 ki dal').amount, 30);
  assert.equal(P('चीनी बीस रुपये की').amount, 20);
  assert.deepEqual([P('do kilo chini').qty, P('do kilo chini').unit, P('do kilo chini').money], [2, 'kg', undefined]);
  assert.deepEqual([P('teen ka maggi').qty, P('teen ka maggi').money], [3, undefined], 'small counts with "ka" are still counts');
  assert.equal(P('2 maggi').qty, 2);
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const products = await m.db.products.toArray();
  const r = m.or.parseOrderText('20 rupaye ki chini\n₹20 का तेल\n50 ka khula atta\n₹20 ki maggi\n2 maggi', products);
  const by = Object.fromEntries(r.lines.map((l) => [l.productId, l]));
  assert.deepEqual([by[g.sugar.id].qty, by[g.sugar.id].amount, by[g.sugar.id].qtyGuessed], [0.44, 20, false]);
  assert.deepEqual([by[g.oil.id].qty, by[g.oil.id].amount], [0.13, 20]);
  assert.deepEqual([by[g.atta.id].qty, by[g.atta.id].amount], [1.25, 50]);
  // "₹20 ki maggi" (a pack) + "2 maggi": merged as count, flagged.
  assert.deepEqual([by[g.maggi.id].qty, by[g.maggi.id].amount, by[g.maggi.id].qtyGuessed, by[g.maggi.id].amountOnPack], [3, undefined, true, true]);
  assert.deepEqual(m.or.pickQty({ qty: null, unit: null, amount: 20 }, g.sugar), { qty: 0.44, guessed: false, amount: 20 });
  assert.deepEqual(m.or.pickQty({ qty: 250, unit: 'g' }, g.sugar), { qty: 0.25, guessed: false });
  // Messages for the counter (Hindi + English).
  for (const l of ['hi', 'en']) for (const k of ['packedAmount', 'addedAmount', 'amountTooSmall']) assert.ok(msgs(l).voice[k], `${l} voice.${k}`);
});

test('orders + baskets keep amounts: billed for the amount at the billing price; packing a different weight drops it; repeat carries it', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const c = await m.addCustomer(shop.id, 'Guddu', '9811111111');
  const o = await m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: [{ productId: g.sugar.id, qty: 0.44, amount: 20 }, { productId: g.oil.id, qty: 0.13, amount: 20 }, { productId: g.maggi.id, qty: 2 }], source: 'paste', billAt: 'packed' });
  assert.deepEqual(o.lines.map((l) => [l.qty, l.amount]), [[0.44, 20], [0.13, 20], [2, undefined]]);
  await assert.rejects(m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: [{ productId: g.maggi.id, qty: 1, amount: 20 }], source: 'manual', billAt: 'packed' }), code('qty'), 'packs by amount refused');
  assert.equal(m.or.orderTotal(o), 20 + 20 + 28);
  const t = tFor('hi');
  assert.match(m.or.confirmText(t, o, c, shop, 68, 'hi'), /चीनी — ₹20 का \(0\.44 किलो\)/);
  // Price of sugar goes up before billing: still ₹20, now 0.4 kg.
  const row2 = await m.db.products.get(g.sugar.id);
  const id = row2.id;
  const input = inputOf(row2);
  await m.saveProduct(shop.id, { ...input, sellPrice: 50 }, id);
  await m.or.setOrderStatus({ orderId: o.id, to: 'packing' });
  await m.or.setPacking(o.id, 1, { packedQty: 0.2 }); // oil: packed 200 ml instead → billed by weight
  const lines = (await m.db.customerOrders.get(o.id)).lines;
  assert.equal(lines[1].amount, undefined);
  const prev = m.or.billPreview(await m.db.customerOrders.get(o.id), new Map((await m.db.products.toArray()).map((p) => [p.id, p])));
  assert.equal(prev.total, 20 + 30 + 28);
  const r = await m.or.setOrderStatus({ orderId: o.id, to: 'ready', pay: { payment: 'cash' } });
  assert.deepEqual(r.sale.items.map((i) => [i.qty, i.amount ?? null]), [[0.4, 20], [0.2, null], [2, null]]);
  assert.equal(r.sale.total, 78);
  // Basket from that bill keeps "₹20 की चीनी"; repeat derives qty at today's price.
  const b = await m.or.basketFromSale(r.sale.id, 'रोज़', c.id);
  assert.deepEqual(b.lines.map((l) => [l.productId, l.amount ?? null]), [[g.sugar.id, 20], [g.oil.id, null], [g.maggi.id, null]]);
  const plan = await m.or.planRepeat(shop.id, { basketId: b.id });
  assert.deepEqual(plan.lines.map((l) => [l.qty, l.amount ?? null]), [[0.4, 20], [0.2, null], [2, null]]);
  await m.or.loadRepeatIntoCart(shop.id, plan);
  const draft = await m.db.saleDrafts.get(shop.id);
  assert.deepEqual(draft.amounts, { [g.sugar.id]: 20 });
  assert.equal(draft.cart[g.sugar.id], 0.4);
  // Basket CSV estimate uses the amount.
  const csv = m.or.basketsCSVRows([b], new Map([[c.id, c]]), new Map((await m.db.products.toArray()).map((p) => [p.id, p])));
  assert.equal(csv[0][5], 20 + 30 + 28);
  assert.match(String(csv[0][3]), /\(Rs 20\)/);
});

test('reorder + purchases in the right units: whole kg / L and whole packs; packed qty must be whole; batch expiry kept per line', async () => {
  const m = loadPhone();
  const { suggestQty, reorderTarget } = m.sp;
  assert.equal(suggestQty({ unit: 'kg', lowStockAt: 2.5, qty: 1.2 }), 4, 'target 5 kg − 1.2 kg = 3.8 → 4 kg');
  assert.equal(suggestQty({ unit: 'ltr', lowStockAt: 0.2, qty: 0 }), 1, 'at least 1 L');
  assert.equal(suggestQty({ unit: 'pkt', lowStockAt: 3, qty: 1 }), 5);
  assert.equal(suggestQty({ unit: 'pkt', lowStockAt: 3, qty: -2, reorderTo: 10 }), 10);
  assert.equal(reorderTarget({ unit: 'kg', lowStockAt: 0.2 }), 1);
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const sup = await m.sp.saveSupplier(shop.id, { name: 'Ramesh Traders' });
  const base = { shopId: shop.id, supplierId: sup.id, day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), paidCash: 0, paidUpi: 0 };
  await assert.rejects(m.sp.recordPurchase({ ...base, lines: [{ productId: g.maggi.id, qty: 1.5, buyPrice: 12 }] }), code('qty'));
  await assert.rejects(m.sp.recordPurchase({ ...base, lines: [{ productId: g.sugar.id, qty: 2.255, buyPrice: 40 }] }), code('qty'));
  await assert.rejects(m.sp.recordPurchase({ ...base, lines: [{ productId: g.maggi.id, qty: 1, buyPrice: 12, expiryDate: '12/10/2026' }] }), code('expiry'));
  // Maggi on the shelf (10, expiry not set) gets this batch's date; then an earlier batch wins.
  await m.sp.recordPurchase({ ...base, lines: [{ productId: g.maggi.id, qty: 12, buyPrice: 12, expiryDate: '2027-03-01' }, { productId: g.sugar.id, qty: 2.25, buyPrice: 40, expiryDate: '2027-01-01' }] });
  assert.equal((await m.db.products.get(g.maggi.id)).expiryDate, '2027-03-01');
  assert.equal((await m.db.products.get(g.sugar.id)).expiryDate, undefined, 'loose: no batch expiry from purchases');
  assert.equal((await m.db.products.get(g.sugar.id)).qty, 12.25);
  await m.sp.recordPurchase({ ...base, lines: [{ productId: g.maggi.id, qty: 6, buyPrice: 12, expiryDate: '2027-01-15' }] });
  assert.equal((await m.db.products.get(g.maggi.id)).expiryDate, '2027-01-15', 'older stock first: the earlier date');
  await m.sp.recordPurchase({ ...base, lines: [{ productId: g.maggi.id, qty: 6, buyPrice: 12, expiryDate: '2027-06-01' }] });
  assert.equal((await m.db.products.get(g.maggi.id)).expiryDate, '2027-01-15');
  const pur = (await m.db.purchases.toArray()).find((p) => p.lines.some((l) => l.expiryDate === '2027-06-01'));
  assert.ok(pur, 'line keeps its batch date');
  // Shelf empty → the new batch's date replaces the old one.
  const row3 = await m.db.products.get(g.attaPack.id);
  const id = row3.id;
  const input = inputOf(row3);
  await m.saveProduct(shop.id, { ...input, expiryDate: '2026-11-01' }, id);
  await m.openPack({ productId: id, packs: 3 });
  await m.sp.recordPurchase({ ...base, lines: [{ productId: id, qty: 5, buyPrice: 48, expiryDate: '2027-02-01' }] });
  assert.equal((await m.db.products.get(id)).expiryDate, '2027-02-01');
});

test('CSV, backup v6 (kind, step, MRP, pack link, amounts, batch expiry); v5 files restore with kind from unit; bad rows refused', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const rows = m.u.productsCSVRows(await m.db.products.toArray());
  const H = m.u.PRODUCTS_CSV_HEADERS;
  const pack = rows.find((r) => r[1] === 'Aashirvaad Atta 1kg');
  assert.deepEqual([pack[H.indexOf('kind')], pack[H.indexOf('mrp')], pack[H.indexOf('opens_into')], pack[H.indexOf('pack_size')]], ['packed', 60, 'Loose Atta', 1]);
  const loose = rows.find((r) => r[1] === 'Loose Atta');
  assert.deepEqual([loose[H.indexOf('kind')], loose[H.indexOf('step')]], ['loose', 0.25]);
  const sale = await m.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 0, amount: 20 }], payment: 'cash' });
  await m.correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 0.1 }], reason: 'x', refundMethod: 'cash' });
  await m.openPack({ productId: g.attaPack.id, packs: 1 });
  assert.equal(m.BACKUP_VERSION, 8);
  const file = await m.createBackup(shop.id);
  const parsed = JSON.parse(file.text);
  assert.equal(parsed.version, 8);
  const { data } = await m.readBackup(file.text);
  const B = loadPhone();
  await B.restoreBackup(data, 'owner-1');
  assert.equal((await B.db.products.get(g.attaPack.id)).looseId, g.atta.id);
  assert.equal((await B.db.sales.get(sale.id)).items[0].amount, 20);
  assert.equal((await B.db.corrections.toArray())[0].lines[0].amount, 4.55);
  assert.equal((await B.db.stockMoves.toArray()).filter((x) => x.reason === 'openPack').length, 2);
  assert.equal((await B.db.products.get(g.atta.id)).qty, 3.5);

  // v5 file: no kind anywhere -> read by unit.
  const v5 = JSON.parse(JSON.stringify(parsed.data));
  v5.products = v5.products.map(({ kind, step, mrp, looseId, packSize, ...p }) => (void kind, void step, void mrp, void looseId, void packSize, p));
  v5.stockMoves = v5.stockMoves.filter((x) => x.reason !== 'openPack');
  const C = loadPhone();
  const { data: d5 } = await C.readBackup(JSON.stringify(await fakeFile(C, v5, 5)));
  await C.restoreBackup(d5, 'owner-1');
  assert.deepEqual((await C.db.products.toArray()).map((p) => [p.unit, p.kind]).sort(), [['kg', 'loose'], ['kg', 'loose'], ['ltr', 'loose'], ['pkt', 'packed'], ['pkt', 'packed']]);

  for (const bad of [
    (d) => (d.products.find((p) => p.unit === 'pkt').kind = 'loose'),
    (d) => (d.products.find((p) => p.looseId).looseId = 'nope'),
    (d) => (d.products.find((p) => p.looseId).packSize = 0),
    (d) => (d.products.find((p) => p.unit === 'kg').step = 0.333),
    (d) => (d.sales[0].items[0].amount = -5),
    (d) => (d.stockMoves[0].reason = 'opened'),
    (d) => (d.corrections[0].lines[0].amount = 'x'),
  ]) {
    const d = JSON.parse(JSON.stringify(parsed.data));
    bad(d);
    await assert.rejects(C.readBackup(JSON.stringify(await fakeFile(C, d, 6))), (e) => e.code === 'invalid');
  }
});

async function fakeFile(m, data, version) {
  const body = JSON.stringify(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const checksum = 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { format: m.BACKUP_FORMAT, version, exportedAt: Date.now(), shopId: data.shop.id, shopName: data.shop.name, checksum, data };
}

test('schema + sync mapping: product columns exist (create block + upgrade), kind CHECK, openPack allowed; null kind read by unit', () => {
  const m = loadPhone();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  const body = sql.match(/create table if not exists products \(([\s\S]*?)\n\);/)[1];
  for (const c of m.SPECS.products.cols) assert.match(body, new RegExp(`\\n\\s+${m.snake(c)}\\s`), `products.${m.snake(c)}`);
  for (const c of ['kind', 'step', 'mrp', 'loose_id', 'pack_size']) assert.match(sql, new RegExp(`alter table products add column if not exists ${c}\\s`));
  assert.match(sql, /products_kind_check check \(kind is null or kind in \('packed', 'loose'\)\)/);
  assert.match(sql, /'supplierReturn', 'openPack'\)\)/);
  assert.ok(m.STOCK_MOVE_REASONS.includes('openPack'));
  const p = { id: 'p', shopId: 's', nameHi: 'आटा', nameEn: 'Atta', unit: 'pkt', kind: 'packed', qty: 3, buyPrice: 48, sellPrice: 55, lowStockAt: 2, mrp: 60, looseId: 'l', packSize: 1, salesCount: 0, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
  assert.deepEqual(m.fromRemote('products', m.toRemote('products', p, 'u')), p);
  const old = m.toRemote('products', { ...p, unit: 'kg', kind: undefined, mrp: undefined, looseId: undefined, packSize: undefined }, 'u');
  old.kind = null;
  assert.equal(m.fromRemote('products', old).kind, 'loose');
});

test('two phones through the mock Supabase: packs / loose fields, an amount bill and an opened pack sync once', async () => {
  const mock = createMock();
  after(() => mock.close());
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const EMAIL = 'packs@shop.test';
  const PASS = 'secret123';
  const A = loadPhone();
  const userA = await A.register(EMAIL, PASS);
  const shop = await makeShop(A, userA.id, crypto.randomUUID());
  const g = await goods(A, shop);
  await A.cloudSignUp(EMAIL, PASS);
  assert.deepEqual(await A.linkShop(shop, userA.id), { status: 'linked' });
  const sale = await A.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 0, amount: 20 }], payment: 'cash' });
  await A.openPack({ productId: g.attaPack.id, packs: 1, note: 'खुला' });
  mock.faults.push({ table: 'stock_moves', status: 503, afterCommit: true, times: 1 });
  assert.ok((await A.syncNow()).error);
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(mock.rows('stock_moves').filter((r) => r.reason === 'openPack').length, 2, 'retry never duplicates');
  const prow = mock.rows('products').find((r) => r.id === g.attaPack.id);
  assert.deepEqual([prow.kind, Number(prow.mrp), prow.loose_id, Number(prow.pack_size)], ['packed', 60, g.atta.id, 1]);
  const B = loadPhone();
  await B.recoverFromCloud(EMAIL, PASS);
  assert.equal((await B.db.products.get(g.atta.id)).qty, 3.5);
  assert.equal((await B.db.products.get(g.attaPack.id)).qty, 2);
  assert.equal((await B.db.products.get(g.sugar.id)).qty, 9.56);
  assert.equal((await B.db.products.get(g.atta.id)).step, 0.25);
  const sb = await B.db.sales.get(sale.id);
  assert.deepEqual([sb.total, sb.items[0].amount, sb.items[0].qty], [20, 20, 0.44]);
});
