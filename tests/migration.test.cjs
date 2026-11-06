/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Upgrading a phone from the v3 database: stock gets an opening move, the queue learns its shop,
// and the old sync's unverified "synced" marks / payload-less deletes are cleaned up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('fake-indexeddb/auto');
const Dexie = require('dexie').default ?? require('dexie');

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};

test('v3 -> v7 upgrade keeps data, makes stock = sum of moves and gives old bills one payment part', async () => {
  const old = new Dexie('dukaanmitra');
  old.version(1).stores({ users: 'id, &email', shops: 'id, ownerId', products: 'id, shopId, barcode, updatedAt', customers: 'id, shopId, updatedAt', sales: 'id, shopId, day, createdAt, [shopId+day]', ledger: 'id, shopId, customerId, createdAt', outbox: '++seq, table, createdAt' });
  old.version(2).stores({ saleDrafts: 'shopId' });
  old.version(3).stores({ corrections: 'id, shopId, saleId, createdAt, [shopId+day]' });
  await old.open();
  const t = Date.now();
  await old.table('products').bulkAdd([
    { id: 'p1', shopId: 's1', nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 7.5, buyPrice: 40, sellPrice: 45, lowStockAt: 1, salesCount: 0, createdAt: t, updatedAt: t },
    { id: 'p2', shopId: 's1', nameHi: 'नमक', nameEn: 'Salt', unit: 'pkt', qty: 0, buyPrice: 20, sellPrice: 25, lowStockAt: 1, salesCount: 0, createdAt: t, updatedAt: t },
  ]);
  // Bills from before split payments: one method each, one partly returned.
  const bill = (id, payment, total, extra = {}) => ({ id, shopId: 's1', items: [{ productId: 'p1', nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 1, price: total, cost: 40 }], total, cost: 40, payment, createdAt: t, day: '2026-10-22', ...extra });
  await old.table('sales').bulkAdd([
    bill('b-cash', 'cash', 45),
    bill('b-upi', 'upi', 90),
    bill('b-credit', 'credit', 45, { customerId: 'c1', status: 'partially_returned', returnedTotal: 10, returnedCost: 5 }),
  ]);
  await old.table('outbox').bulkAdd([
    { table: 'products', op: 'upsert', rowId: 'p1', payload: { id: 'p1', shopId: 's1' }, createdAt: t, syncedAt: t },
    { table: 'shops', op: 'upsert', rowId: 's1', payload: { id: 's1' }, createdAt: t },
    { table: 'products', op: 'delete', rowId: 'gone', payload: null, createdAt: t },
  ]);
  old.close();

  const { db } = require('../src/lib/db.ts');
  const { recomputeDerived } = require('../src/lib/sync.ts');
  await db.open();
  assert.equal(db.verno, 10);
  assert.deepEqual((await db.sales.where('customerId').equals('c1').toArray()).map((x) => x.id), ['b-credit'], 'v7 customer index built for old bills');
  assert.equal(await db.cashEntries.count(), 0);
  const parts = Object.fromEntries((await db.sales.toArray()).map((x) => [x.id, x.payments]));
  assert.deepEqual(parts, {
    'b-cash': [{ method: 'cash', amount: 45, status: 'paid' }],
    'b-upi': [{ method: 'upi', amount: 90, status: 'paid' }],
    'b-credit': [{ method: 'credit', amount: 45, status: 'paid' }],
  });
  const credit = await db.sales.get('b-credit');
  assert.equal(credit.payment, 'credit', 'old method kept (lossless)');
  assert.equal(credit.returnedTotal, 10);
  assert.equal(credit.customerId, 'c1');
  assert.equal((await db.products.get('p1')).qty, 7.5);
  assert.deepEqual((await db.stockMoves.toArray()).map((m) => [m.productId, m.delta, m.reason]), [['p1', 7.5, 'opening']]);
  const ob = await db.outbox.orderBy('seq').toArray();
  assert.deepEqual(ob.map((o) => [o.table, o.rowId, o.shopId, o.syncedAt]), [['products', 'p1', 's1', undefined], ['shops', 's1', 's1', undefined]]);
  await recomputeDerived('s1');
  assert.equal((await db.products.get('p1')).qty, 7.5, 'derived stock equals stored stock');
  assert.equal((await db.products.get('p2')).qty, 0);
});
