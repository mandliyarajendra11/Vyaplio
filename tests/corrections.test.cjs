/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Bill cancellation & returns: one transaction reverses stock, money and udhaar; history is append-only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('fake-indexeddb/auto');

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const { db } = require('../src/lib/db.ts');
const { recordSale, saveProduct, correctSale, CorrectionError, netTotal } = require('../src/lib/ops.ts');
const { computeDayStats } = require('../src/lib/stats.ts');
const { dayKey } = require('../src/lib/dates.ts');

const SHOP = 'corr-shop';
const product = (nameEn, qty, sellPrice, buyPrice, unit = 'pcs') =>
  saveProduct(SHOP, { nameHi: nameEn, nameEn, unit, qty, sellPrice, buyPrice, lowStockAt: 1 });
const code = (re) => (e) => e instanceof CorrectionError && re.test(e.code);
const today = async () => {
  const day = dayKey(Date.now());
  return computeDayStats(
    await db.sales.where('[shopId+day]').equals([SHOP, day]).toArray(),
    await db.corrections.where('[shopId+day]').equals([SHOP, day]).toArray(),
    await db.ledger.where('shopId').equals(SHOP).toArray(),
  );
};

test('credit bill: partial return then cancel rest restores stock, udhaar and day totals', async () => {
  const sugar = await product('Sugar', 10, 45, 40, 'kg');
  const maggi = await product('Maggi', 20, 14, 12);
  const sale = await recordSale({
    shopId: SHOP, payment: 'credit', newCustomer: { name: 'Ramu' },
    lines: [{ product: sugar, qty: 2 }, { product: maggi, qty: 5 }],
  });
  assert.equal(sale.total, 160);
  const cust = sale.customerId;
  assert.equal((await db.customers.get(cust)).balance, 160);
  let s = await today();
  assert.deepEqual([s.total, s.credit, s.profit, s.count], [160, 160, 20, 1]);

  // Return 0.5 kg sugar + 2 maggi -> 22.5 + 28 = 50.5 off udhaar
  const outboxBefore = await db.outbox.count();
  const c1 = await correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 0.5 }, { index: 1, qty: 2 }], reason: 'Customer returned', refundMethod: 'credit', byName: 'Owner' });
  assert.equal(c1.amount, 50.5);
  assert.equal(c1.cost, 44);
  let saved = await db.sales.get(sale.id);
  assert.equal(saved.status, 'partially_returned');
  assert.equal(saved.returnedTotal, 50.5);
  assert.equal(netTotal(saved), 109.5);
  assert.equal((await db.products.get(sugar.id)).qty, 8.5);
  assert.equal((await db.products.get(maggi.id)).qty, 17);
  const cAfter1 = await db.customers.get(cust);
  assert.equal(cAfter1.balance, 109.5);
  assert.equal(cAfter1.lastPaidAt, undefined, 'a return is not a payment');
  assert.ok((await db.outbox.count()) >= outboxBefore + 5, 'sale, 2 products, ledger, customer, correction queued');
  assert.ok((await db.outbox.where('table').equals('sale_corrections').count()) === 1);
  s = await today();
  assert.deepEqual([s.total, s.credit, s.returns, s.received, s.count], [109.5, 109.5, 50.5, 0, 1]);

  // Over-return is blocked and changes nothing
  await assert.rejects(correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 1, qty: 4 }], reason: 'x', refundMethod: 'credit' }), code(/over/));
  assert.equal((await db.products.get(maggi.id)).qty, 17);

  // Cancel everything left
  const c2 = await correctSale({ saleId: sale.id, type: 'cancel', reason: 'Wrong bill', refundMethod: 'credit', byName: 'Owner' });
  assert.equal(c2.amount, 109.5);
  saved = await db.sales.get(sale.id);
  assert.equal(saved.status, 'cancelled');
  assert.equal(netTotal(saved), 0);
  assert.equal((await db.products.get(sugar.id)).qty, 10);
  assert.equal((await db.products.get(maggi.id)).qty, 20);
  assert.equal((await db.customers.get(cust)).balance, 0);
  const ledger = await db.ledger.where('customerId').equals(cust).toArray();
  assert.equal(ledger.filter((e) => e.kind === 'return').length, 2);
  s = await today();
  assert.deepEqual([s.total, s.credit, s.profit, s.count], [0, 0, 0, 0]);

  // Double cancel / return after cancel are blocked; history is kept, bill not deleted
  await assert.rejects(correctSale({ saleId: sale.id, type: 'cancel', reason: 'again', refundMethod: 'credit' }), code(/cancelled/));
  await assert.rejects(correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 0.5 }], reason: 'x', refundMethod: 'credit' }), code(/cancelled/));
  assert.equal((await db.corrections.where('saleId').equals(sale.id).count()), 2);
  assert.ok(await db.sales.get(sale.id));
});

test('cash bill: reason and method are validated; cash refund lowers cash and profit', async () => {
  const oil = await product('Oil', 5, 170, 150);
  const sale = await recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: oil, qty: 2 }] });
  const before = await today();
  await assert.rejects(correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: '   ', refundMethod: 'cash' }), code(/reason/));
  await assert.rejects(correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'x', refundMethod: 'credit' }), code(/method/));
  await assert.rejects(correctSale({ saleId: sale.id, type: 'return', lines: [], reason: 'x', refundMethod: 'cash' }), code(/empty/));
  assert.equal((await db.products.get(oil.id)).qty, 3);

  await correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'Leaking', refundMethod: 'cash' });
  const after = await today();
  assert.equal(after.cash, before.cash - 170);
  assert.equal(after.profit, before.profit - 20);
  assert.equal((await db.products.get(oil.id)).qty, 4);
  // No UPI came in on this cash bill: a UPI refund is refused unless explicitly marked cross-method.
  await assert.rejects(correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'Leaking', refundMethod: 'upi' }), code(/method/));
  assert.equal((await db.products.get(oil.id)).qty, 4);
  // Returning the last unit (explicit cross-method UPI refund) fully reverses the bill
  await correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'Leaking', refundMethod: 'upi', crossMethod: true });
  assert.equal((await db.sales.get(sale.id)).status, 'cancelled');
  assert.equal((await today()).upi, before.upi - 170);
  const corr = (await db.corrections.where('saleId').equals(sale.id).sortBy('createdAt')).pop();
  assert.equal(corr.crossMethod, true);
});

test('a failure mid-correction rolls everything back', async () => {
  const salt = await product('Salt', 10, 28, 25);
  const sale = await recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: salt, qty: 3 }] });
  const outbox = await db.outbox.count();
  const fail = () => { throw new Error('Simulated disk failure'); };
  db.corrections.hook('creating', fail);
  try {
    await assert.rejects(correctSale({ saleId: sale.id, type: 'cancel', reason: 'x', refundMethod: 'cash' }), /Simulated/);
  } finally {
    db.corrections.hook('creating').unsubscribe(fail);
  }
  assert.equal((await db.products.get(salt.id)).qty, 7);
  const s = await db.sales.get(sale.id);
  assert.equal(s.status, undefined);
  assert.equal(s.returnedTotal, undefined);
  assert.equal(await db.outbox.count(), outbox);
});
