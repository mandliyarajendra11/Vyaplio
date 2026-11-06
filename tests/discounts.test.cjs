/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('fake-indexeddb/auto');
globalThis.WebSocket ??= class {};
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { db } = require('../src/lib/db.ts');
const { discountAmount, allocateDiscount, DiscountError, totalDiscount, itemDiscountTotal, billDiscountTotal } = require('../src/lib/discounts.ts');
const { lineTotal, partValue } = require('../src/lib/units.ts');
const { recordSale, correctSale, saveProduct, addCustomer } = require('../src/lib/ops.ts');
const { marginTotals, buildReport } = require('../src/lib/profit.ts');
const { createBackup, readBackup, restoreBackup } = require('../src/lib/backup.ts');
const { toRemote, fromRemote } = require('../src/lib/syncSchema.ts');
const { saveSaleDraft, emptySaleDraft } = require('../src/lib/saleDraft.ts');
const { parseMoney, formatINR } = require('../src/lib/money.ts');
const { createTranslator } = require('use-intl/core');
const { billText } = require('../src/lib/share.ts');
const { receiptHtml } = require('../src/lib/receipt.ts');
async function setup() {
  const now = Date.now(), id = crypto.randomUUID();
  const shop = { id, ownerId: 'owner', name: 'Test shop', ownerName: 'Owner', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now };
  await db.shops.add(shop);
  const p = await saveProduct(id, { nameHi: 'चावल', nameEn: 'Rice', unit: 'kg', qty: 10, sellPrice: 100, buyPrice: 40, lowStockAt: 1 });
  return { shop, p };
}

test('rupees, percent, Hindi digits and invalid input; allocation conserves paise', () => {
  assert.equal(discountAmount(123.45, { kind: 'percent', value: parseMoney('१२.५') }), 15.43);
  for (const value of [-1, NaN, Infinity, 100.01, 1.001]) assert.throws(() => discountAmount(100, { kind: 'percent', value }), DiscountError);
  assert.throws(() => discountAmount(10, { kind: 'amount', value: 10.01 }), DiscountError);
  assert.throws(() => discountAmount(10, { kind: 'bad', value: 1 }), DiscountError);
  const items = Array.from({ length: 3 }, () => ({ qty: 1, price: 1 }));
  const allocated = allocateDiscount(items, { kind: 'amount', value: 1 });
  assert.deepEqual(allocated.map(x => x.discount), [0.34, 0.33, 0.33]);
  assert.equal(Math.round(allocated.reduce((a,x) => a + lineTotal(x), 0) * 100), 200);
  const line = { qty: 3, price: 100, discount: 100 };
  assert.deepEqual([0,1,2].map(already => partValue(line, 1, already)), [66.67,66.66,66.67]);
  for (let cents = 0; cents <= 300; cents++) {
    const result = allocateDiscount(items, { kind: 'amount', value: cents / 100 });
    assert.equal(Math.round(result.reduce((a,x) => a + lineTotal(x), 0) * 100), 300 - cents);
    assert.ok(result.every(x => lineTotal(x) >= 0));
  }
});

test('discounted credit sale, partial return, cancellation and profit agree', async () => {
  const { shop, p } = await setup();
  const customer = await addCustomer(shop.id, 'Buyer');
  const sale = await recordSale({ shopId: shop.id, lines: [{ product: p, qty: 3 }], payment: 'credit', customerId: customer.id, discount: { kind: 'amount', value: 100 } });
  assert.equal(sale.total, 200);
  assert.equal((await db.customers.get(customer.id)).balance, 200);
  const c1 = await correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'Return', refundMethod: 'credit' });
  assert.equal(c1.amount, 66.67);
  assert.equal(c1.lines[0].amount, 66.67);
  assert.equal((await db.customers.get(customer.id)).balance, 133.33);
  const totals = marginTotals([sale], [c1]);
  assert.deepEqual([totals.netSales, totals.knownSales, totals.cogs, totals.margin], [133.33, 133.33, 80, 53.33]);
  const report = buildReport({ from: sale.day, to: sale.day, sales: [sale], corrections: [c1], saleById: new Map(), products: [p], ledger: [], cash: [], moves: [] });
  assert.equal(report.items[0].sales, 133.33);
  assert.equal(report.items[0].margin, 53.33);
  const c2 = await correctSale({ saleId: sale.id, type: 'cancel', reason: 'Cancel rest', refundMethod: 'credit' });
  assert.equal(c2.amount, 133.33);
  assert.equal((await db.customers.get(customer.id)).balance, 0);
  assert.equal((await db.products.get(p.id)).qty, 10);
  assert.equal(marginTotals([sale], [c1, c2]).margin, 0);
});

test('loose amount lines retain quantity and refund the discounted amount without drift', async () => {
  const { shop, p } = await setup();
  const sale = await recordSale({ shopId: shop.id, lines: [{ product: { ...p, sellPrice: 45 }, qty: 0.44, amount: 20 }], payment: 'cash', discount: { kind: 'percent', value: 10 } });
  assert.deepEqual([sale.items[0].qty, sale.items[0].amount, sale.total], [0.44, 20, 18]);
  assert.equal(partValue(sale.items[0], 0.22), 9);
  for (const locale of ['hi','en']) {
    const t = createTranslator({ locale, messages: require(`../src/messages/${locale}.json`), onError: e => { throw e; } });
    const text = billText(t, sale, shop, locale);
    const html = receiptHtml(t, { sale, shop, locale, format: '58mm' });
    for (const output of [text,html]) {
      assert.ok(output.includes(t('discount.title')));
      assert.ok(output.includes(formatINR(18)));
      assert.ok(output.includes(formatINR(2)));
    }
  }
});

test('split payment and pending UPI refunds use net payable, invalid requests write nothing', async () => {
  const { shop, p } = await setup();
  const opts = { shopId: shop.id, lines: [{ product: p, qty: 1 }], payment: 'cash', discount: { kind: 'amount', value: 10 } };
  const sale = await recordSale({ ...opts, payments: [{ method: 'cash', amount: 40, tendered: 50 }, { method: 'upi', amount: 50, upi: 'pending' }] });
  assert.equal(sale.total, 90);
  assert.equal(sale.payments[0].change, 10);
  const back = await correctSale({ saleId: sale.id, type: 'cancel', reason: 'Cancel', refundMethod: 'cash' });
  assert.deepEqual(back.refunds, [{ method: 'upiPending', amount: 50 }, { method: 'cash', amount: 40 }]);
  await assert.rejects(recordSale({ ...opts, discount: { kind: 'amount', value: 101 } }), DiscountError);
  await assert.rejects(recordSale({ ...opts, payments: [{ method: 'cash', amount: 100 }] }), e => e.code === 'sum');
  assert.equal(await db.sales.where('shopId').equals(shop.id).count(), 1);
  assert.equal((await db.products.get(p.id)).qty, 10);
});

test('100% discount has zero payable but preserves cost and reversible stock', async () => {
  const { shop, p } = await setup();
  const sale = await recordSale({ shopId: shop.id, lines: [{ product: p, qty: 1 }], payment: 'cash', discount: { kind: 'percent', value: 100 } });
  assert.equal(sale.total, 0);
  assert.equal(marginTotals([sale], []).margin, -40);
  const back = await correctSale({ saleId: sale.id, type: 'cancel', reason: 'Cancel free sale', refundMethod: 'cash' });
  assert.equal(back.amount, 0);
  assert.equal((await db.products.get(p.id)).qty, 10);
});

test('discounts preserve honest unknown-cost coverage and flag sales below cost', () => {
  const items = allocateDiscount([
    { productId: 'known', nameHi: 'Known', nameEn: 'Known', unit: 'pcs', qty: 1, price: 100, cost: 95, costKnown: true },
    { productId: 'unknown', nameHi: 'Unknown', nameEn: 'Unknown', unit: 'pcs', qty: 1, price: 100, cost: 0, costKnown: false },
  ], { kind: 'percent', value: 10 });
  const sale = { id: 'mixed', total: 180, items, payment: 'cash', createdAt: Date.now() };
  const report = buildReport({ from: '2026-11-01', to: '2026-11-01', sales: [sale], corrections: [], saleById: new Map(), products: [], ledger: [], cash: [], moves: [] });
  assert.deepEqual([report.knownSales, report.unknownSales, report.margin, report.coverage], [90,90,-5,0.5]);
  assert.ok(report.items[0].flags.includes('aboveSell'));
  assert.equal(report.missing[0].sales, 90);
});

test('discount draft survives reload; backups and cloud mapping retain line allocations', async () => {
  const { shop, p } = await setup();
  const draft = { ...emptySaleDraft(shop.id), cart: { [p.id]: 1 }, discount: { kind: 'percent', value: '१०' } };
  await saveSaleDraft(draft);
  assert.deepEqual((await db.saleDrafts.get(shop.id)).discount, draft.discount);
  const sale = await recordSale({ shopId: shop.id, lines: [{ product: p, qty: 1 }], payment: 'cash', draftId: draft.id, discount: { kind: 'percent', value: 10 } });
  assert.equal(await db.saleDrafts.get(shop.id), undefined);
  assert.deepEqual(fromRemote('sales', toRemote('sales', sale, 'owner')).items, sale.items);
  const file = await createBackup(shop.id);
  assert.equal(JSON.parse(file.text).version, 8);
  const { data } = await readBackup(file.text);
  await restoreBackup(data, 'owner', shop.id);
  assert.equal((await db.sales.get(sale.id)).items[0].discount, 10);
  assert.equal(marginTotals([await db.sales.get(sale.id)], []).margin, 50);
});

test('item discounts apply before bill discounts; returns and profit use the combined net', async () => {
  const { shop, p } = await setup();
  const pack = await saveProduct(shop.id, { nameHi: 'नमक', nameEn: 'Salt', unit: 'pkt', qty: 10, sellPrice: 50, buyPrice: 20, lowStockAt: 1 });
  const sale = await recordSale({ shopId: shop.id, payment: 'cash', discount: { kind: 'percent', value: 10 }, lines: [
    { product: p, qty: 2, discount: { kind: 'amount', value: 20 } },
    { product: pack, qty: 2, discount: { kind: 'percent', value: 50 } },
  ] });
  // 300 - (20 + 50) = 230; then 10% = 23. Net line amounts: 162 + 45.
  assert.equal(sale.total, 207);
  assert.deepEqual(sale.items.map(it => [it.itemDiscount, it.discount, lineTotal(it)]), [[20,38,162],[50,55,45]]);
  assert.deepEqual([totalDiscount(sale.items), itemDiscountTotal(sale.items), billDiscountTotal(sale.items)], [93,70,23]);
  assert.equal(marginTotals([sale], []).margin, 87);
  const back = await correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 1 }, { index: 1, qty: 1 }], reason: 'Half returned', refundMethod: 'cash' });
  assert.equal(back.amount, 103.5);
  assert.equal(marginTotals([sale], [back]).margin, 43.5);
  const rest = await correctSale({ saleId: sale.id, type: 'cancel', reason: 'Remainder returned', refundMethod: 'cash' });
  assert.equal(rest.amount, 103.5);
  assert.equal(marginTotals([sale], [back, rest]).margin, 0);
  assert.equal((await db.products.get(p.id)).qty, 10);
  assert.equal((await db.products.get(pack.id)).qty, 10);
  for (const locale of ['hi','en']) {
    const t = createTranslator({ locale, messages: require(`../src/messages/${locale}.json`), onError: e => { throw e; } });
    for (const output of [billText(t, sale, shop, locale), receiptHtml(t, { sale, shop, locale, format: '58mm' })]) {
      assert.ok(output.includes(t('discount.itemsTotal')));
      assert.ok(output.includes(t('discount.title')));
      assert.ok(output.includes(formatINR(70)));
      assert.ok(output.includes(formatINR(23)));
      assert.ok(output.includes(formatINR(300)));
    }
  }
});

test('zero-value item gets no bill allocation; invalid item or remaining bill discounts write nothing', async () => {
  const { shop, p } = await setup();
  const base = { shopId: shop.id, payment: 'cash', lines: [{ product: p, qty: 1, discount: { kind: 'amount', value: 101 } }] };
  await assert.rejects(recordSale(base), DiscountError);
  await assert.rejects(recordSale({ ...base, lines: [{ product: p, qty: 1, discount: { kind: 'percent', value: 50 } }], discount: { kind: 'amount', value: 51 } }), DiscountError);
  assert.equal(await db.sales.where('shopId').equals(shop.id).count(), 0);
  assert.equal((await db.products.get(p.id)).qty, 10);
  const result = allocateDiscount([{ qty: 1, price: 100, discount: 100, itemDiscount: 100 }, { qty: 1, price: 100, discount: 0 }], { kind: 'amount', value: 10 });
  assert.deepEqual(result.map(it => lineTotal(it)), [0,90]);
  assert.deepEqual(allocateDiscount([{ qty: 1, price: 100, discount: 100 }], { kind: 'percent', value: 100 }).map(lineTotal), [0]);
});

test('loose amount item discounts persist through draft, cloud mapping and backup; malformed breakdown rejected', async () => {
  const { shop, p } = await setup();
  const draft = { ...emptySaleDraft(shop.id), cart: { [p.id]: 0.44 }, amounts: { [p.id]: 20 }, itemDiscounts: { [p.id]: { kind: 'percent', value: '१०' } } };
  await saveSaleDraft(draft);
  assert.deepEqual((await db.saleDrafts.get(shop.id)).itemDiscounts, draft.itemDiscounts);
  const sale = await recordSale({ shopId: shop.id, payment: 'credit', newCustomer: { name: 'Buyer' }, draftId: draft.id,
    lines: [{ product: { ...p, sellPrice: 45 }, qty: 0.44, amount: 20, discount: { kind: 'percent', value: 10 } }] });
  assert.deepEqual([sale.items[0].amount, sale.items[0].qty, sale.items[0].itemDiscount, sale.total], [20,0.44,2,18]);
  assert.equal((await db.customers.get(sale.customerId)).balance, 18);
  assert.deepEqual(fromRemote('sales', toRemote('sales', sale, 'owner')).items, sale.items);
  const file = await createBackup(shop.id);
  const broken = JSON.parse(file.text);
  broken.data.sales[0].items[0].itemDiscount = 3;
  broken.checksum = 'sha256:' + require('node:crypto').createHash('sha256').update(JSON.stringify(broken.data)).digest('hex');
  await assert.rejects(readBackup(JSON.stringify(broken)), e => e.code === 'invalid' && e.detail.includes('itemDiscount'));
  const { data } = await readBackup(file.text);
  await restoreBackup(data, 'owner', shop.id);
  assert.equal((await db.sales.get(sale.id)).items[0].itemDiscount, 2);
  const back = await correctSale({ saleId: sale.id, type: 'return', lines: [{ index: 0, qty: 0.22 }], reason: 'Half', refundMethod: 'credit' });
  assert.equal(back.amount, 9);
  assert.equal((await db.customers.get(sale.customerId)).balance, 9);
});
