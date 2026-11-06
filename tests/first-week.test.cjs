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
const { db } = require('../src/lib/db.ts');
const { saveProduct } = require('../src/lib/ops.ts');
const { markBackup } = require('../src/lib/backupReminder.ts');
const { closeDay } = require('../src/lib/cash.ts');
const { FIRST_WEEK_STEPS, loadFirstWeekProgress, markFirstWeekStep, skipFirstWeekStep } = require('../src/lib/firstWeek.ts');

test('first-week progress uses real records; skipped steps can be resumed', async () => {
  const shop = { id: 'first-week-shop', createdAt: Date.now(), name: 'Shop', ownerName: 'Owner' };
  assert.deepEqual(FIRST_WEEK_STEPS, ['products', 'practice', 'stock', 'backup', 'close']);
  let p = await loadFirstWeekProgress(shop);
  assert.equal(Object.values(p.done).filter(Boolean).length, 0);
  await skipFirstWeekStep(shop.id, 'backup', true);
  p = await loadFirstWeekProgress(shop);
  assert.equal(p.state.skipped.includes('backup'), true);
  assert.equal(p.done.backup, false, 'skipping is not a fake backup');
  await skipFirstWeekStep(shop.id, 'backup', false);
  assert.equal((await loadFirstWeekProgress(shop)).state.skipped.includes('backup'), false);
  await saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 2, sellPrice: 40, buyPrice: 30, lowStockAt: 1 });
  await markFirstWeekStep(shop.id, 'practice');
  await markFirstWeekStep(shop.id, 'stock');
  await markBackup(shop.id);
  p = await loadFirstWeekProgress(shop);
  assert.deepEqual([p.done.products, p.done.practice, p.done.stock, p.done.backup, p.done.close], [true, true, true, true, false]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await closeDay({ shopId: shop.id, day: today, counted: 0 });
  assert.equal((await loadFirstWeekProgress(shop)).done.close, true);
  await db.delete();
});
