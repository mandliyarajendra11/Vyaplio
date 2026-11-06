/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// WhatsApp repeat orders (item 13): customers with address / landmark (cash customers too), saved
// baskets (from a bill or by hand), repeat into the cart at today's prices (price changes, shortage,
// missing items flagged – never blocking), pasted WhatsApp text -> order lines (item-8 matcher +
// quantity parser), the order status machine, billing exactly once (stock moves only with the bill),
// cancel, WhatsApp texts, CSV, backup v5 (+ v4 files), schema / sync columns and two phones through
// the mock Supabase.
// Run: node tests/orders.test.cjs
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
    ...require('../src/lib/dates.ts'),
    ...require('../src/lib/auth.ts'),
    ...require('../src/lib/cloud.ts'),
    ...require('../src/lib/sync.ts'),
    ...require('../src/lib/backup.ts'),
    ...require('../src/lib/syncSchema.ts'),
    ...require('../src/lib/whatsapp.ts'),
    ...require('../src/lib/bills.ts'),
    or: require('../src/lib/orders.ts'),
  };
}
const msgs = (l) => JSON.parse(fs.readFileSync(path.join(SRC, 'messages', `${l}.json`), 'utf8'));
const tFor = (l) => createTranslator({ locale: l, messages: msgs(l) });
const code = (c) => (e) => e.code === c;
const tick = () => new Promise((r) => setTimeout(r, 3));

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
  const atta = await m.saveProduct(shop.id, { nameHi: 'आटा', nameEn: 'Atta', unit: 'kg', qty: 3, sellPrice: 40, buyPrice: 34, lowStockAt: 5 });
  const oil = await m.saveProduct(shop.id, { nameHi: 'सरसों तेल', nameEn: 'Mustard Oil', unit: 'ltr', qty: 20, sellPrice: 150, buyPrice: 140, lowStockAt: 2 });
  const maggi = await m.saveProduct(shop.id, { nameHi: 'मैगी', nameEn: 'Maggi', unit: 'pkt', qty: 0, sellPrice: 14, buyPrice: 12, lowStockAt: 5 });
  const salt = await m.saveProduct(shop.id, { nameHi: 'नमक', nameEn: 'Salt', unit: 'pkt', qty: 8, sellPrice: 28, buyPrice: 22, lowStockAt: 4 });
  return { sugar, atta, oil, maggi, salt };
}

/* ------------------------------------------------------------------ */

test('customers: cash customers with phone + address / landmark; a cash bill keeps its customer (bill lookup finds it)', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const { sugar } = await goods(m, shop);
  const c = await m.addCustomer(shop.id, '  Sharma ji ', '98765 43210', { address: ' 12, Gali 3 ', landmark: 'मंदिर के पीछे' });
  assert.deepEqual([c.name, c.phone, c.address, c.landmark, c.balance], ['Sharma ji', '9876543210', '12, Gali 3', 'मंदिर के पीछे', 0]);
  const e = await m.updateCustomer(c.id, { name: 'Sharma Ji', phone: '', address: 'Gali 4', landmark: '' });
  assert.deepEqual([e.name, e.phone, e.address, e.landmark], ['Sharma Ji', undefined, 'Gali 4', undefined]);
  assert.ok(e.updatedAt > c.updatedAt - 1);
  const s = await m.recordSale({ shopId: shop.id, lines: [{ product: sugar, qty: 1 }], payment: 'cash', customerId: c.id });
  assert.equal(s.customerId, c.id, 'cash bill linked to its customer');
  assert.equal((await m.db.customers.get(c.id)).balance, 0, 'no udhaar on a cash bill');
  const u = await m.recordSale({ shopId: shop.id, lines: [{ product: sugar, qty: 1 }], payment: 'upi', newCustomer: { name: 'Naya Grahak', phone: '9000000001' } });
  const nc = await m.db.customers.get(u.customerId);
  assert.equal(nc?.name, 'Naya Grahak', 'a name on a UPI bill saves the customer');
  const ghost = await m.recordSale({ shopId: shop.id, lines: [{ product: sugar, qty: 1 }], payment: 'cash', customerId: 'not-there' });
  assert.equal(ghost.customerId, undefined, 'unknown customer is not linked on a cash bill');
  // Item 7 lookup: bills of a cash customer.
  if (m.filterBills) {
    const rows = await m.db.sales.toArray();
    assert.ok(rows.filter((x) => x.customerId === c.id).length === 1);
  }
});

test('paste parse: Hinglish WhatsApp text -> items with quantities ("do kilo chini"), unmatched lines kept for a manual pick', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const products = await m.db.products.toArray();
  assert.deepEqual(m.or.splitOrderText('1. do kilo chini\n- aata 5 kg aur 2 packet maggi, *tel* 1 litre;  maggi x2'), ['do kilo chini', 'aata 5 kg', '2 packet maggi', 'tel 1 litre', 'maggi 2']);
  const text = 'Bhaiya namaste 🙏\n1. do kilo chini\n2. aata 5 kg aur 2 packet maggi\n*sarson tel* 1 litre\nnamak\nmaggi x1\nqwzx plmk 3';
  const r = m.or.parseOrderText(text, products);
  const got = Object.fromEntries(r.lines.map((l) => [l.productId, [l.qty, l.qtyGuessed]]));
  assert.deepEqual(got[g.sugar.id], [2, false], 'do kilo chini = 2 kg sugar');
  assert.deepEqual(got[g.atta.id], [5, false]);
  assert.deepEqual(got[g.maggi.id], [3, false], 'two maggi lines merged (2 + 1)');
  assert.deepEqual(got[g.oil.id], [1, false]);
  assert.deepEqual(got[g.salt.id], [1, true], 'no quantity: 1 assumed and flagged');
  assert.deepEqual(r.unmatched.map((u) => u.raw), ['Bhaiya namaste 🙏', 'qwzx plmk 3']);
  assert.equal(r.unmatched[1].said.qty, 3, 'quantity remembered for the manual pick');
  assert.equal(m.or.qtyForPick(r.unmatched[1].said, 'kg'), 3);
  assert.equal(m.or.qtyForPick({ qty: null, unit: null }, 'pkt'), 1);
  // Devanagari and English lines too.
  const r2 = m.or.parseOrderText('चीनी 1 किलो\nSalt 2', products);
  assert.deepEqual(r2.lines.map((l) => [l.productId, l.qty]), [[g.sugar.id, 1], [g.salt.id, 2]]);
  // Half kilo of a loose item; a fractional packet is not a clean match quantity.
  const r3 = m.or.parseOrderText('aadha kilo chini', products);
  assert.deepEqual(r3.lines.map((l) => [l.productId, l.qty]), [[g.sugar.id, 0.5]]);
});

test('baskets: from a bill (returns left out, cash customer ok) or by hand; edit quantities; delete is a synced tombstone', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const c = await m.addCustomer(shop.id, 'Guddu', '9811111111');
  const s = await m.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 5 }, { product: g.salt, qty: 2 }, { product: g.oil, qty: 1 }], payment: 'cash', customerId: c.id });
  await m.correctSale({ saleId: s.id, type: 'return', lines: [{ index: 2, qty: 1 }], reason: 'leak', refundMethod: 'cash', byName: 'x' });
  const b = await m.or.basketFromSale(s.id, '  महीने का   राशन ');
  assert.equal(b.name, 'महीने का राशन');
  assert.equal(b.customerId, c.id);
  assert.equal(b.fromSaleId, s.id);
  assert.deepEqual(b.lines.map((l) => [l.productId, l.qty, l.price]), [[g.sugar.id, 5, 45], [g.salt.id, 2, 28]], 'returned oil left out');
  // A bill without a customer needs one.
  const anon = await m.recordSale({ shopId: shop.id, lines: [{ product: g.sugar, qty: 1 }], payment: 'cash' });
  await assert.rejects(m.or.basketFromSale(anon.id, 'x'), code('customer'));
  const b2 = await m.or.basketFromSale(anon.id, 'हफ्ते का दूध', c.id);
  assert.equal(b2.customerId, c.id);
  await assert.rejects(m.or.basketFromSale(s.id, '   '), code('name'));
  // By hand + edit.
  const h = await m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'Roz', lines: [{ productId: g.atta.id, qty: 2.5 }, { productId: g.atta.id, qty: 0.5 }] });
  assert.deepEqual(h.lines.map((l) => [l.productId, l.qty]), [[g.atta.id, 3]], 'same item merged');
  await assert.rejects(m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'x', lines: [{ productId: g.salt.id, qty: 1.5 }] }), code('qty'));
  await assert.rejects(m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'x', lines: [] }), code('lines'));
  await assert.rejects(m.or.saveBasket({ shopId: shop.id, customerId: 'nope', name: 'x', lines: [{ productId: g.salt.id, qty: 1 }] }), code('customer'));
  await tick();
  const h2 = await m.or.saveBasket({ id: h.id, shopId: shop.id, customerId: c.id, name: 'Roz ka', lines: [{ productId: g.atta.id, qty: 4 }, { productId: g.salt.id, qty: 1 }] });
  assert.ok(h2.updatedAt > h.updatedAt);
  assert.deepEqual(h2.lines.map((l) => l.qty), [4, 1]);
  await m.or.deleteBasket(h.id);
  const all = await m.db.baskets.where('customerId').equals(c.id).toArray();
  assert.equal(all.length, 3, 'tombstone kept');
  assert.deepEqual(m.or.liveBaskets(all).map((x) => x.name), ['महीने का राशन', 'हफ्ते का दूध']);
  await assert.rejects(m.or.saveBasket({ id: h.id, shopId: shop.id, customerId: c.id, name: 'again', lines: [{ productId: g.salt.id, qty: 1 }] }), code('notFound'));
  const queued = (await m.db.outbox.toArray()).filter((o) => o.table === 'baskets');
  assert.ok(queued.some((o) => o.rowId === h.id && o.payload.deletedAt), 'delete queued for the other phones');
});

test('repeat: basket / last bill at today\'s prices; price change, shortage, out of stock and removed items flagged, never blocking', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const c = await m.addCustomer(shop.id, 'Guddu');
  const b = await m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'महीने का राशन', lines: [{ productId: g.sugar.id, qty: 2 }, { productId: g.atta.id, qty: 5 }, { productId: g.maggi.id, qty: 2 }, { productId: g.salt.id, qty: 1 }] });
  await m.saveProduct(shop.id, { ...g.sugar, sellPrice: 48 }, g.sugar.id); // price went up
  await m.deleteProduct(g.salt.id); // no longer sold
  const plan = await m.or.planRepeat(shop.id, { basketId: b.id }, 'hi');
  const by = Object.fromEntries(plan.lines.map((l) => [l.product.id, l]));
  assert.deepEqual([by[g.sugar.id].oldPrice, by[g.sugar.id].product.sellPrice, by[g.sugar.id].priceChanged], [45, 48, true]);
  assert.deepEqual([by[g.atta.id].short, by[g.atta.id].out], [true, false], '5 kg asked, 3 kg on record');
  assert.deepEqual([by[g.maggi.id].short, by[g.maggi.id].out], [true, true]);
  assert.deepEqual(plan.missing, ['नमक']);
  assert.equal(plan.kind, 'basket');
  await m.or.loadRepeatIntoCart(shop.id, plan);
  const d = await m.db.saleDrafts.get(shop.id);
  assert.deepEqual(d.cart, { [g.sugar.id]: 2, [g.atta.id]: 5, [g.maggi.id]: 2 });
  assert.equal(d.customerId, c.id);
  assert.deepEqual(d.repeat.prices, { [g.sugar.id]: 45, [g.atta.id]: 40, [g.maggi.id]: 14 });
  assert.deepEqual(d.repeat.missing, ['नमक']);
  // Checkout as usual (udhaar) – shortages recorded, not blocked; today's price used.
  const lines = plan.lines.map((l) => ({ product: l.product, qty: l.qty }));
  const sale = await m.recordSale({ shopId: shop.id, lines, payment: 'credit', customerId: c.id, draftId: d.id });
  assert.equal(sale.total, 2 * 48 + 5 * 40 + 2 * 14);
  assert.equal((await m.db.products.get(g.atta.id)).qty, -2, 'sold anyway: stock shows the shortage (item 4)');
  assert.equal((await m.db.customers.get(c.id)).balance, sale.total);
  assert.equal(await m.db.saleDrafts.get(shop.id), undefined, 'cart cleared after the bill');
  // Repeat last bill: the newest bill with something left.
  await m.recordSale({ shopId: shop.id, lines: [{ product: g.oil, qty: 1 }], payment: 'cash', customerId: c.id });
  const last = await m.or.planRepeat(shop.id, { customerId: c.id }, 'en');
  assert.equal(last.kind, 'bill');
  assert.deepEqual(last.lines.map((l) => [l.product.id, l.qty, l.priceChanged]), [[g.oil.id, 1, false]]);
  const other = await m.addCustomer(shop.id, 'New');
  await assert.rejects(m.or.planRepeat(shop.id, { customerId: other.id }), code('noBill'));
});

test('order status machine: new -> packing -> ready -> out -> delivered; picked-up; cancel; illegal steps refused', () => {
  const { or } = loadPhone();
  assert.ok(or.canMove('new', 'packing') && or.canMove('packing', 'ready') && or.canMove('ready', 'out') && or.canMove('ready', 'picked') && or.canMove('out', 'delivered'));
  assert.ok(!or.canMove('new', 'delivered') && !or.canMove('delivered', 'cancelled') && !or.canMove('picked', 'out') && !or.canMove('out', 'ready'));
  for (const s of ['new', 'packing', 'ready', 'out']) assert.ok(or.canMove(s, 'cancelled') && or.isPending(s));
  assert.ok(or.isDone('picked') && or.isDone('delivered') && !or.isPending('cancelled'));
  assert.ok(or.billsOn('packed', 'ready') && or.billsOn('packed', 'out') && !or.billsOn('packed', 'packing'));
  assert.ok(or.billsOn('delivery', 'delivered') && or.billsOn('delivery', 'picked') && !or.billsOn('delivery', 'out') && !or.billsOn('delivery', 'cancelled'));
  const ev = (status, at, type = 'status', saleId) => ({ type, status, createdAt: at, saleId });
  assert.equal(or.orderState([ev('new', 1), ev('packing', 2), ev('ready', 3)]).status, 'ready');
  // Two phones: out of order arrival still gives the furthest step.
  assert.equal(or.orderState([ev('ready', 3), ev('new', 1), ev('packing', 2), ev('packing', 4)]).status, 'ready');
  assert.equal(or.orderState([ev('new', 1), ev('cancelled', 2)]).status, 'cancelled');
  // A bill wins over a cancel from another phone.
  const s = or.orderState([ev('new', 1), ev('ready', 3), ev(undefined, 3, 'bill', 'o-bill'), ev('cancelled', 4)]);
  assert.deepEqual([s.status, s.saleId], ['ready', 'o-bill']);
  assert.equal(or.orderState([ev('new', 1), ev('cancelled', 2)], true, 'o').status, 'new', 'bill row arrived before its event');
  assert.equal(or.orderBillId('abc'), 'abc-bill');
});

test('order from pasted text: packing checklist, ready + out messages, delivered -> one bill with udhaar; stock moves only at the bill; repeat calls never bill twice', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const t = tFor('hi');
  const products = await m.db.products.toArray();
  const text = 'do kilo chini\naata 2 kg\nek packet namak\nbaaki kal bataunga';
  const r = m.or.parseOrderText(text, products);
  const o = await m.or.createOrder({ shopId: shop.id, newCustomer: { name: 'Pinky', phone: '9822222222', address: 'B-4', landmark: 'पानी की टंकी' }, lines: r.lines.map((l) => ({ productId: l.productId, qty: l.qty })), source: 'paste', text, unmatched: r.unmatched.map((u) => u.raw), billAt: 'delivery', byName: 'Suresh' });
  const c = await m.db.customers.get(o.customerId);
  assert.deepEqual([c.name, c.address, c.landmark], ['Pinky', 'B-4', 'पानी की टंकी']);
  assert.deepEqual(o.unmatched, ['baaki kal bataunga']);
  assert.equal((await m.or.stateOf(o.id)).status, 'new');
  const stock0 = (await m.db.products.get(g.sugar.id)).qty;

  // Confirmation message with the estimate.
  const conf = m.or.confirmText(t, o, c, shop, m.or.orderTotal(o), 'hi');
  assert.match(conf, /Pinky/);
  assert.match(conf, /चीनी — 2 किलो/);
  assert.match(conf, /₹198/); // 2×45 + 2×40 + 1×28
  const link = m.waLink(conf, c.phone);
  assert.match(link, /^https:\/\/wa\.me\/919822222222\?text=/);

  await assert.rejects(m.or.setOrderStatus({ orderId: o.id, to: 'ready' }), code('status'));
  await m.or.setOrderStatus({ orderId: o.id, to: 'packing', byName: 'Suresh' });
  await m.or.setPacking(o.id, 0, { packed: true });
  await m.or.setPacking(o.id, 1, { packed: true, packedQty: 1.5 }); // only 1.5 kg atta
  await assert.rejects(m.or.setPacking(o.id, 2, { packedQty: 0.5 }), code('qty'), 'half packet refused');
  await m.or.setPacking(o.id, 2, { packed: true });
  const packed = await m.db.customerOrders.get(o.id);
  assert.deepEqual(packed.lines.map((l) => [l.packed, m.or.billQty(l)]), [[true, 2], [true, 1.5], [true, 1]]);
  const pack = m.or.packingText(t, packed, c, 'hi');
  assert.match(pack, /☑ आटा — 1.5 किलो/);
  assert.match(pack, /पानी की टंकी/);
  assert.match(pack, /baaki kal bataunga/);

  await m.or.setOrderStatus({ orderId: o.id, to: 'ready' });
  const ready = m.or.statusText(t, 'ready', packed, c, shop, m.or.orderTotal(packed, undefined, true));
  assert.match(ready, /तैयार/);
  assert.match(ready, /₹178/); // packed: 1.5 kg atta
  await assert.rejects(m.or.setPacking(o.id, 0, { packed: false }), code('status'), 'packing locked after ready');
  await m.or.setOrderStatus({ orderId: o.id, to: 'out' });
  assert.equal((await m.db.products.get(g.sugar.id)).qty, stock0, 'no stock move before the bill');
  assert.equal(await m.db.sales.count(), 0);

  // Delivery = billing point: payment needed.
  await assert.rejects(m.or.setOrderStatus({ orderId: o.id, to: 'delivered' }), code('payment'));
  const res = await m.or.setOrderStatus({ orderId: o.id, to: 'delivered', pay: { payment: 'credit' }, byName: 'Suresh' });
  assert.equal(res.state.status, 'delivered');
  assert.equal(res.sale.id, `${o.id}-bill`);
  assert.equal(res.sale.orderId, o.id);
  assert.equal(res.sale.total, 178);
  assert.equal((await m.db.customers.get(c.id)).balance, 178, 'udhaar to the order customer');
  assert.equal((await m.db.products.get(g.sugar.id)).qty, stock0 - 2);
  assert.equal((await m.db.products.get(g.atta.id)).qty, 1.5);
  // Once only.
  const again = await m.or.setOrderStatus({ orderId: o.id, to: 'delivered', pay: { payment: 'credit' } });
  assert.equal(again.sale.id, res.sale.id);
  await assert.rejects(m.or.setOrderStatus({ orderId: o.id, to: 'cancelled' }), code('billed'));
  assert.equal(await m.db.sales.count(), 1);
  assert.equal((await m.db.customers.get(c.id)).balance, 178);
  assert.equal(await m.db.ledger.count(), 1);
  assert.deepEqual((await m.db.stockMoves.toArray()).filter((x) => x.id.startsWith(res.sale.id)).map((x) => x.id).sort(), [0, 1, 2].map((i) => `${res.sale.id}-m${i}`), 'fixed stock-move ids');
  // A replay of the same bill (as a second phone would do) changes nothing.
  await m.recordSale({ shopId: shop.id, lines: [{ product: await m.db.products.get(g.sugar.id), qty: 2 }], payment: 'credit', customerId: c.id, orderId: o.id });
  assert.equal(await m.db.sales.count(), 1);
  assert.equal((await m.db.customers.get(c.id)).balance, 178);
  assert.equal((await m.db.products.get(g.sugar.id)).qty, stock0 - 2);
  await assert.rejects(m.or.setPacking(o.id, 0, { packed: false }), code('billed'));
  const rows = await m.or.loadOrders(shop.id);
  assert.deepEqual([rows[0].state.status, rows[0].sale?.id], ['delivered', res.sale.id]);
});

test('bill when packed; pick-up; cancel before the bill leaves stock alone; zero-packed lines skipped; empty order cannot bill', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const c = await m.addCustomer(shop.id, 'Raju', '9833333333');
  const b = await m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'Roz', lines: [{ productId: g.sugar.id, qty: 1 }, { productId: g.maggi.id, qty: 2 }] });
  const o = await m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: b.lines, source: 'basket', basketId: b.id, billAt: 'packed' });
  await m.or.setOrderStatus({ orderId: o.id, to: 'packing' });
  await m.or.setPacking(o.id, 1, { packed: true, packedQty: 0 }); // maggi not available
  const r = await m.or.setOrderStatus({ orderId: o.id, to: 'ready', pay: { payment: 'cash' } });
  assert.deepEqual(r.sale.items.map((it) => [it.productId, it.qty]), [[g.sugar.id, 1]]);
  assert.equal(r.sale.customerId, c.id, 'cash bill keeps the customer');
  assert.equal((await m.db.customers.get(c.id)).balance, 0);
  const r2 = await m.or.setOrderStatus({ orderId: o.id, to: 'picked' });
  assert.equal(r2.state.status, 'picked');
  assert.equal(r2.sale, undefined, 'no second bill');
  assert.equal(await m.db.sales.count(), 1);
  await assert.rejects(m.or.setOrderStatus({ orderId: o.id, to: 'delivered' }), code('status'));

  // Cancel.
  const before = (await m.db.products.get(g.sugar.id)).qty;
  const x = await m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: [{ productId: g.sugar.id, qty: 3 }], source: 'manual', billAt: 'delivery' });
  await m.or.setOrderStatus({ orderId: x.id, to: 'packing' });
  const cx = await m.or.setOrderStatus({ orderId: x.id, to: 'cancelled', note: 'customer said no' });
  assert.equal(cx.state.status, 'cancelled');
  assert.equal((await m.db.products.get(g.sugar.id)).qty, before);
  await assert.rejects(m.or.setOrderStatus({ orderId: x.id, to: 'ready' }), code('status'));
  await assert.rejects(m.or.setPacking(x.id, 0, { packed: true }), code('status'));

  // Everything packed as 0: refused, nothing written.
  const z = await m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: [{ productId: g.maggi.id, qty: 1 }], source: 'manual', billAt: 'packed' });
  await m.or.setPacking(z.id, 0, { packedQty: 0 });
  await assert.rejects(m.or.setOrderStatus({ orderId: z.id, to: 'packing' }).then(() => m.or.setOrderStatus({ orderId: z.id, to: 'ready', pay: { payment: 'cash' } })), code('empty'));
  assert.equal((await m.or.stateOf(z.id)).status, 'packing', 'failed bill rolls back the step');
  // Input checks.
  await assert.rejects(m.or.createOrder({ shopId: shop.id, lines: [{ productId: g.sugar.id, qty: 1 }], source: 'manual', billAt: 'delivery' }), code('customer'));
  await assert.rejects(m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: [], source: 'manual', billAt: 'delivery' }), code('lines'));
  // Home counts.
  const counts = await m.or.orderCounts(shop.id, Date.now());
  assert.deepEqual(counts, { pending: 1, today: 1, ready: 0 });
});

test('CSV: orders and baskets exports', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const c = await m.addCustomer(shop.id, 'Guddu, "G"', '9811111111');
  const b = await m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'महीने का राशन', lines: [{ productId: g.sugar.id, qty: 2 }, { productId: g.oil.id, qty: 1 }] });
  const o = await m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: b.lines, source: 'basket', basketId: b.id, billAt: 'packed', unmatched: ['kuch aur'], byName: 'Suresh' });
  await m.or.setOrderStatus({ orderId: o.id, to: 'packing' });
  await m.or.setOrderStatus({ orderId: o.id, to: 'ready', pay: { payment: 'upi' } });
  const rows = m.or.ordersCSVRows(await m.or.loadOrders(shop.id));
  assert.equal(rows.length, 1);
  const H = m.or.ORDERS_CSV_HEADERS;
  const row = Object.fromEntries(H.map((h, i) => [h, rows[0][i]]));
  assert.equal(row.customer, 'Guddu, "G"');
  assert.equal(row.status, 'ready');
  assert.equal(row.bill_at, 'packed');
  assert.equal(row.source, 'basket');
  assert.match(String(row.items), /Sugar 2 kg/);
  assert.equal(Number(row.bill_total), 240);
  assert.equal(row.unmatched, 'kuch aur');
  const products = new Map((await m.db.products.toArray()).map((p) => [p.id, p]));
  const brows = m.or.basketsCSVRows(await m.db.baskets.toArray(), new Map([[c.id, c]]), products);
  const B = m.or.BASKETS_CSV_HEADERS;
  const br = Object.fromEntries(B.map((h, i) => [h, brows[0][i]]));
  assert.deepEqual([br.basket, Number(br.item_count), Number(br.estimate)], ['महीने का राशन', 2, 240]);
  if (m.toCSV) assert.match(m.toCSV(H, rows), /"Guddu, ""G"""/);
});

test('backup v5 carries baskets, orders and their history; v4 files still restore; bad rows refused', async () => {
  const m = loadPhone();
  const shop = await makeShop(m);
  const g = await goods(m, shop);
  const c = await m.addCustomer(shop.id, 'Guddu', '9811111111', { address: 'Gali 2', landmark: 'Temple' });
  const b = await m.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'Roz', lines: [{ productId: g.sugar.id, qty: 1 }] });
  const o = await m.or.createOrder({ shopId: shop.id, customerId: c.id, lines: b.lines, source: 'basket', basketId: b.id, billAt: 'packed' });
  await m.or.setOrderStatus({ orderId: o.id, to: 'packing' });
  await m.or.setOrderStatus({ orderId: o.id, to: 'ready', pay: { payment: 'credit' } });
  assert.equal(m.BACKUP_VERSION, 8);
  const file = await m.createBackup(shop.id);
  const parsed = JSON.parse(file.text);
  assert.equal(parsed.version, 8);
  assert.deepEqual([parsed.data.baskets.length, parsed.data.customerOrders.length, parsed.data.orderEvents.length], [1, 1, 4]);
  const { data, preview } = await m.readBackup(file.text);
  assert.deepEqual([preview.baskets, preview.customerOrders], [1, 1]);
  const B = loadPhone();
  await B.restoreBackup(data, 'owner-1');
  assert.equal((await B.or.stateOf(o.id)).status, 'ready');
  assert.equal((await B.db.sales.get(`${o.id}-bill`)).orderId, o.id);
  assert.equal((await B.db.customers.get(c.id)).landmark, 'Temple');
  assert.equal((await B.db.customers.get(c.id)).balance, 45);

  const v4 = JSON.parse(JSON.stringify(parsed.data));
  delete v4.baskets; delete v4.customerOrders; delete v4.orderEvents;
  v4.sales = v4.sales.map(({ orderId, ...s }) => (void orderId, s));
  v4.customers = v4.customers.map(({ address, landmark, ...x }) => (void address, void landmark, x));
  const C = loadPhone();
  const { data: d4 } = await C.readBackup(JSON.stringify(await fakeFile(C, v4, 4)));
  await C.restoreBackup(d4, 'owner-1');
  assert.equal(await C.db.baskets.count(), 0);
  assert.equal(await C.db.sales.count(), 1);

  for (const bad of [
    (d) => (d.customerOrders[0].billAt = 'sometime'),
    (d) => (d.customerOrders[0].customerId = 'nope'),
    (d) => (d.orderEvents.find((e) => e.type === 'status').status = 'lost'),
    (d) => (d.orderEvents[0].orderId = 'nope'),
    (d) => (d.baskets[0].lines = 'x'),
    (d) => (d.baskets[0].customerId = 'nope'),
  ]) {
    const d = JSON.parse(JSON.stringify(parsed.data));
    bad(d);
    await assert.rejects(C.readBackup(JSON.stringify(await fakeFile(C, d, 5))), (e) => e.code === 'invalid');
  }
});

async function fakeFile(m, data, version) {
  const body = JSON.stringify(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const checksum = 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { format: m.BACKUP_FORMAT, version, exportedAt: Date.now(), shopId: data.shop.id, shopName: data.shop.name, checksum, data };
}

test('schema: synced columns exist in supabase/schema.sql; new tables have RLS / CHECKs; events insert-only; re-runnable', () => {
  const m = loadPhone();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  for (const t of ['baskets', 'customer_orders', 'order_events', 'customers', 'sales']) {
    const body = sql.match(new RegExp(`create table if not exists ${t} \\(([\\s\\S]*?)\\n\\);`))[1];
    for (const c of m.SPECS[t].cols) assert.match(body, new RegExp(`\\n\\s+${m.snake(c)}\\s`), `${t}.${m.snake(c)}`);
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`));
    assert.ok(m.SYNC_ORDER.includes(t));
  }
  for (const [t, c] of [['customers', 'address'], ['customers', 'landmark'], ['sales', 'order_id']]) assert.match(sql, new RegExp(`alter table ${t} add column if not exists ${c}`));
  assert.equal(m.SPECS.order_events.appendOnly, true);
  assert.ok(!m.SPECS.baskets.appendOnly && !m.SPECS.customer_orders.appendOnly);
  assert.ok(m.SYNC_ORDER.indexOf('customers') < m.SYNC_ORDER.indexOf('customer_orders'));
  assert.ok(m.SYNC_ORDER.indexOf('customer_orders') < m.SYNC_ORDER.indexOf('order_events'));
  assert.doesNotMatch(sql, /create policy "[^"]*" on order_events for (all|update|delete)/, 'events are insert-only');
  assert.doesNotMatch(sql, /create table (?!if not exists)/, 're-runnable');
  const o = { id: 'x', shopId: 's', customerId: 'c', lines: [{ productId: 'a', nameHi: 'अ', nameEn: 'a', unit: 'kg', qty: 1, price: 2, packed: true, packedQty: 0.5 }], source: 'paste', text: 'do kilo', unmatched: ['x'], billAt: 'delivery', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
  assert.deepEqual(m.fromRemote('customer_orders', m.toRemote('customer_orders', o, 'u')), o);
});

test('two phones through the mock Supabase: baskets, orders, packing and the single bill sync; retries never duplicate', async () => {
  const mock = createMock();
  after(() => mock.close());
  process.env.NEXT_PUBLIC_SUPABASE_URL = await mock.listen(0);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const EMAIL = 'orders@shop.test';
  const PASS = 'secret123';
  const A = loadPhone();
  const userA = await A.register(EMAIL, PASS);
  const shop = await makeShop(A, userA.id, crypto.randomUUID());
  const g = await goods(A, shop);
  await A.cloudSignUp(EMAIL, PASS);
  assert.deepEqual(await A.linkShop(shop, userA.id), { status: 'linked' });
  const c = await A.addCustomer(shop.id, 'Guddu', '9811111111', { address: 'Gali 2', landmark: 'मंदिर' });
  const b = await A.or.saveBasket({ shopId: shop.id, customerId: c.id, name: 'महीने का राशन', lines: [{ productId: g.sugar.id, qty: 2 }, { productId: g.oil.id, qty: 1 }] });
  const o = await A.or.createOrder({ shopId: shop.id, customerId: c.id, lines: b.lines, source: 'basket', basketId: b.id, billAt: 'delivery' });
  mock.faults.push({ table: 'order_events', status: 503, afterCommit: true, times: 1 });
  assert.ok((await A.syncNow()).error);
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(mock.rows('order_events').length, 1);
  assert.equal(mock.rows('baskets').length, 1);
  assert.equal(mock.rows('customers')[0].landmark, 'मंदिर');

  const B = loadPhone();
  await B.recoverFromCloud(EMAIL, PASS);
  assert.equal((await B.or.stateOf(o.id)).status, 'new');
  assert.equal((await B.db.baskets.get(b.id)).name, 'महीने का राशन');
  // B packs, A moves it on.
  await B.or.setOrderStatus({ orderId: o.id, to: 'packing' });
  await B.or.setPacking(o.id, 0, { packed: true, packedQty: 1.5 });
  await B.or.setPacking(o.id, 1, { packed: true });
  await B.or.setOrderStatus({ orderId: o.id, to: 'ready' });
  await B.or.saveBasket({ id: b.id, shopId: shop.id, customerId: c.id, name: 'महीने का राशन', lines: [{ productId: g.sugar.id, qty: 3 }] });
  for (const m of [B, A]) assert.equal((await m.syncNow()).error, undefined);
  assert.equal((await A.or.stateOf(o.id)).status, 'ready');
  assert.equal(A.or.billQty((await A.db.customerOrders.get(o.id)).lines[0]), 1.5);
  assert.deepEqual((await A.db.baskets.get(b.id)).lines.map((l) => l.qty), [3], 'basket edit arrives');
  await A.or.setOrderStatus({ orderId: o.id, to: 'out' });
  // Delivered on A with udhaar; the bill result is lost once – retry must not duplicate.
  mock.faults.push({ table: 'sales', status: 503, afterCommit: true, times: 1 });
  const r = await A.or.setOrderStatus({ orderId: o.id, to: 'delivered', pay: { payment: 'credit' } });
  assert.ok((await A.syncNow()).error);
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal(mock.rows('sales').length, 1);
  assert.equal(mock.rows('sales')[0].order_id, o.id);
  assert.equal((await B.syncNow()).error, undefined);
  const sb = await B.or.stateOf(o.id);
  assert.deepEqual([sb.status, sb.saleId], ['delivered', r.sale.id]);
  assert.equal((await B.db.customers.get(c.id)).balance, r.sale.total);
  assert.equal((await B.db.products.get(g.sugar.id)).qty, 10 - 1.5);
  // B (late) tries to cancel: refused because the bill is there.
  await assert.rejects(B.or.setOrderStatus({ orderId: o.id, to: 'cancelled' }), code('billed'));
  // Insert-only events on the server.
  const { createClient } = require('@supabase/supabase-js');
  const other = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, 'test-anon-key', { auth: { persistSession: false } });
  await other.auth.signInWithPassword({ email: EMAIL, password: PASS });
  const row = mock.rows('order_events')[0];
  const res = await other.from('order_events').upsert([{ ...row, status: 'cancelled' }]).select('id');
  assert.ok(res.error, 'order events cannot be overwritten');
  // Basket delete syncs as a tombstone.
  await A.or.deleteBasket(b.id);
  assert.equal((await A.syncNow()).error, undefined);
  assert.equal((await B.syncNow()).error, undefined);
  assert.ok((await B.db.baskets.get(b.id)).deletedAt);
});

test('i18n: orders / basket / customer strings exist in Hindi and English with the same placeholders', () => {
  const hi = msgs('hi');
  const en = msgs('en');
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
  for (const ns of ['orders', 'basket', 'customer']) {
    assert.deepEqual(Object.keys(hi[ns]).sort(), Object.keys(en[ns]).sort(), ns);
    for (const k of Object.keys(hi[ns])) assert.equal(ph(hi[ns][k]), ph(en[ns][k]), `${ns}.${k}`);
  }
  for (const s of ['new', 'packing', 'ready', 'out', 'picked', 'delivered', 'cancelled']) assert.ok(hi.orders[`status_${s}`] && en.orders[`status_${s}`], s);
  for (const c of ['customer', 'lines', 'qty', 'notFound', 'status', 'billed', 'payment', 'name', 'empty', 'noBill']) assert.ok(hi.orders[`err_${c}`] && en.orders[`err_${c}`], c);
  for (const [ns, k] of [['home', 'ordersLine'], ['more', 'ordersTitle'], ['sale', 'repeatPrice'], ['udhaar', 'landmark'], ['backup', 'previewOrders']]) assert.ok(hi[ns][k] && en[ns][k], `${ns}.${k}`);
  // WhatsApp texts render in both languages.
  for (const l of ['hi', 'en']) {
    const t = tFor(l);
    const o = { id: 'abc12345', lines: [{ productId: 'p', nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 2, price: 45 }] };
    assert.match(m_or().confirmText(t, o, { name: 'Guddu' }, { name: 'Shop' }, 90, l), /ABC12/);
    assert.match(m_or().statusText(t, 'out', o, { name: 'Guddu' }, { name: 'Shop' }, 90), /₹90/);
  }
});
let _or;
const m_or = () => (_or ??= loadPhone().or);
