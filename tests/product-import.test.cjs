/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const nodeCrypto = require('node:crypto');
require('fake-indexeddb/auto');
globalThis.crypto ??= nodeCrypto.webcrypto;
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  module._compile(outputText, filename);
};
const importer = require('../src/lib/productImport.ts');
const { db } = require('../src/lib/db.ts');
const { importProducts, quickSetProduct } = require('../src/lib/ops.ts');

test('CSV preview parses Hindi, quoted commas, escaped quotes, and catches bad rows', () => {
  const rows = importer.readImport('\uFEFFname,unit,sell_price,buy_price,qty,barcode\r\n"नमक, मोटा",kg,20,10,1.25,\r\n"Soap ""large""",pcs,30,,2,abc');
  assert.equal(rows[0].name, 'नमक, मोटा');
  assert.equal(rows[1].name, 'Soap "large"');
  assert.deepEqual(importer.validateImport(rows, [], (k) => k), []);
  assert.equal(importer.validateImport([{ ...rows[1], qty: '1.5' }], [], (k) => k)[0].message, 'badQty');
  assert.equal(importer.validateImport(rows, [{ nameHi: 'नमक, मोटा', nameEn: '', barcode: '' }], (k) => k)[0].message, 'duplicateName');
  assert.throws(() => importer.readImport('name,sell_price,ignored\na,5,x'), /csvExtra/);
  assert.throws(() => importer.readImport('name,sell_price\n"a,5'), /csvFormat/);
});

test('bulk import is atomic and quick edit records a count move', async () => {
  const shop = 'import-shop';
  const input = (name, qty, unit = 'pcs') => ({ nameHi: name, nameEn: name, unit, qty, sellPrice: 20, buyPrice: 10, lowStockAt: 5 });
  const rows = await importProducts(shop, [input('साबुन', 4), input('चीनी', 1.25, 'kg')]);
  assert.equal(rows.length, 2);
  assert.equal((await db.stockMoves.where('shopId').equals(shop).toArray()).length, 2);
  await assert.rejects(importProducts(shop, [input('तेल', 2), input('साबुन', 1)]), /importChanged/);
  assert.equal((await db.products.where('shopId').equals(shop).toArray()).length, 2);
  await assert.rejects(importProducts(shop, [input('चाय', 1), input('गलत', 1.5)]), /importInvalid/);
  assert.equal((await db.products.where('shopId').equals(shop).toArray()).length, 2);
  await quickSetProduct(shop, rows[0].id, 25, 11, 7);
  const saved = await db.products.get(rows[0].id);
  assert.equal(saved.qty, 7);
  assert.equal(saved.sellPrice, 25);
  const moves = await db.stockMoves.where('productId').equals(rows[0].id).toArray();
  assert.equal(moves.reduce((sum, m) => sum + m.delta, 0), 7);
  assert.equal(moves.filter((m) => m.reason === 'count').length, 1);
  await assert.rejects(quickSetProduct(shop, rows[0].id, 25, 11, 1.5), /quickQty/);
  await db.delete();
});
