/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('fake-indexeddb/auto');
globalThis.WebSocket ??= class {};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { db } = require('../src/lib/db.ts');
const { roundOffAmount, roundOffTotal, roundSaleItems } = require('../src/lib/discounts.ts');
const { lineTotal, partValue } = require('../src/lib/units.ts');
const { recordSale, correctSale, saveProduct, addCustomer } = require('../src/lib/ops.ts');
const { marginTotals } = require('../src/lib/profit.ts');
const { createBackup, readBackup, restoreBackup } = require('../src/lib/backup.ts');
const { toRemote, fromRemote } = require('../src/lib/syncSchema.ts');
const { saveSaleDraft, emptySaleDraft } = require('../src/lib/saleDraft.ts');
const { createTranslator } = require('use-intl/core');
const { billText } = require('../src/lib/share.ts');
const { receiptHtml } = require('../src/lib/receipt.ts');
async function setup(price = 10.49) {
  const now = Date.now(), id = crypto.randomUUID();
  const shop = { id, ownerId: 'owner', name: 'Test shop', ownerName: 'Owner', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now };
  await db.shops.add(shop);
  const product = await saveProduct(id, { nameHi: 'सामान', nameEn: 'Item', unit: 'pcs', qty: 10, sellPrice: price, buyPrice: 4, lowStockAt: 1 });
  return { shop, product };
}

test('nearest rupee handles both directions, 50 paise, zero and several tiny lines', () => {
  assert.deepEqual([0,0.49,0.5,0.51,10.99].map(roundOffAmount), [0,-0.49,0.5,0.49,0.01]);
  const down = roundSaleItems([{ qty: 1, price: 0.2 }, { qty: 1, price: 0.2 }]);
  assert.equal(roundOffTotal(down), -0.4);
  assert.deepEqual(down.map(lineTotal), [0,0]);
  const up = roundSaleItems([{ qty: 1, price: 10.5 }, { qty: 1, price: 5 }]);
  assert.equal(roundOffTotal(up), 0.5);
  assert.equal(up.reduce((a, l) => a + lineTotal(l), 0), 16);
  const fair = roundSaleItems([{ qty: 1, price: 10.25 }, { qty: 1, price: 10.25 }]);
  assert.deepEqual(fair.map(lineTotal), [10.5,10.5]);
});

test('optional rounding changes payable cash, profit and partial-return refunds', async () => {
  const { shop, product } = await setup();
  const normal = await recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product, qty: 1 }] });
  assert.equal(normal.total, 10.49);
  assert.equal(roundOffTotal(normal.items), 0);
  const rounded = await recordSale({ shopId: shop.id, payment: 'cash', roundToRupee: true,
    lines: [{ product, qty: 2 }], payments: [{ method: 'cash', amount: 21, tendered: 50 }] });
  assert.deepEqual([rounded.total, roundOffTotal(rounded.items), rounded.payments[0].change], [21,0.02,29]);
  assert.equal(marginTotals([rounded], []).margin, 13);
  assert.deepEqual([partValue(rounded.items[0],1,0),partValue(rounded.items[0],1,1)], [10.5,10.5]);
  const back = await correctSale({ saleId: rounded.id, type: 'return', lines: [{ index: 0, qty: 1 }], reason: 'One returned', refundMethod: 'cash' });
  assert.equal(back.amount, 10.5);
  const rest = await correctSale({ saleId: rounded.id, type: 'cancel', reason: 'Rest returned', refundMethod: 'cash' });
  assert.equal(rest.amount, 10.5);
  assert.equal(marginTotals([rounded], [back,rest]).margin, 0);
});

test('rounding follows item and whole-bill discounts, credit and split amounts', async () => {
  const { shop, product } = await setup(20.45);
  const customer = await addCustomer(shop.id, 'Buyer');
  const sale = await recordSale({ shopId: shop.id, payment: 'cash', customerId: customer.id, roundToRupee: true,
    lines: [{ product, qty: 1, discount: { kind: 'amount', value: 0.2 } }],
    discount: { kind: 'amount', value: 0.1 },
    payments: [{ method: 'cash', amount: 10, tendered: 20 }, { method: 'credit', amount: 10 }],
  });
  assert.deepEqual([sale.total, sale.items[0].discount, roundOffTotal(sale.items)], [20,0.3,-0.15]);
  assert.equal((await db.customers.get(customer.id)).balance, 10);
  const back = await correctSale({ saleId: sale.id, type: 'cancel', reason: 'Return', refundMethod: 'credit' });
  assert.equal(back.amount, 20);
  assert.equal((await db.customers.get(customer.id)).balance, 0);
  assert.equal(marginTotals([sale], [back]).margin, 0);
  for (const locale of ['hi','en']) {
    const t = createTranslator({ locale, messages: require(`../src/messages/${locale}.json`), onError: e => { throw e; } });
    for (const output of [billText(t, sale, shop, locale), receiptHtml(t, { sale, shop, locale, format: '58mm' })]) {
      assert.ok(output.includes(t('rounding.line')));
      assert.ok(output.includes(t('discount.title')));
    }
  }
});

test('draft, backup and cloud mapping retain round-off; invalid restored allocation is refused', async () => {
  const { shop, product } = await setup();
  const draft = { ...emptySaleDraft(shop.id), cart: { [product.id]: 1 }, roundToRupee: true };
  await saveSaleDraft(draft);
  assert.equal((await db.saleDrafts.get(shop.id)).roundToRupee, true);
  const sale = await recordSale({ shopId: shop.id, payment: 'cash', draftId: draft.id, roundToRupee: true, lines: [{ product, qty: 1 }] });
  assert.deepEqual([sale.total, roundOffTotal(sale.items)], [10,-0.49]);
  assert.equal(await db.saleDrafts.get(shop.id), undefined);
  assert.deepEqual(fromRemote('sales', toRemote('sales', sale, 'owner')).items, sale.items);
  const file = await createBackup(shop.id);
  assert.equal(JSON.parse(file.text).version, 8);
  const tampered = JSON.parse(file.text);
  tampered.data.sales[0].items[0].rounding = 0.4;
  tampered.data.sales[0].total = 10.89;
  tampered.data.sales[0].payments[0].amount = 10.89;
  tampered.checksum = 'sha256:' + require('node:crypto').createHash('sha256').update(JSON.stringify(tampered.data)).digest('hex');
  await assert.rejects(readBackup(JSON.stringify(tampered)), e => e.code === 'invalid' && /rounding/.test(e.detail));
  const { data } = await readBackup(file.text);
  await restoreBackup(data,'owner',shop.id);
  assert.equal((await db.sales.get(sale.id)).items[0].rounding,-0.49);
});
