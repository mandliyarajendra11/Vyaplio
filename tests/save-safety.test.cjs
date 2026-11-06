/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('fake-indexeddb/auto');

// Compile the application's TypeScript in memory; no generated source files.
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const { db } = require('../src/lib/db.ts');
const { recordSale, addLedger, saveProduct } = require('../src/lib/ops.ts');

test('failed credit sale rolls back its new customer, stock, ledger, and outbox; retry saves once', async () => {
  const product = await saveProduct('test-shop', {
    nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 10,
    sellPrice: 40, buyPrice: 30, lowStockAt: 2,
  });
  const pending = await db.outbox.count();
  const fail = () => { throw new Error('Simulated ledger storage failure'); };
  db.ledger.hook('creating', fail);
  const input = { shopId: 'test-shop', lines: [{ product, qty: 1 }], payment: 'credit', newCustomer: { name: 'Test customer' } };
  try {
    await assert.rejects(recordSale(input), /Simulated/);
  } finally {
    db.ledger.hook('creating').unsubscribe(fail);
  }
  assert.equal(await db.customers.count(), 0);
  assert.equal(await db.sales.count(), 0);
  assert.equal(await db.ledger.count(), 0);
  assert.equal(await db.outbox.count(), pending);
  assert.equal((await db.products.get(product.id)).qty, 10);
  const sale = await recordSale(input);
  assert.equal(await db.customers.count(), 1);
  assert.equal(await db.sales.count(), 1);
  assert.equal(await db.ledger.count(), 1);
  assert.equal((await db.customers.get(sale.customerId)).balance, 40);
  assert.equal((await db.products.get(product.id)).qty, 9);
  await assert.rejects(addLedger('other-shop', sale.customerId, 'credit', 10), /Customer/);
  await assert.rejects(addLedger('test-shop', sale.customerId, 'credit', Infinity), /Invalid/);
  assert.equal((await db.customers.get(sale.customerId)).balance, 40);
});

test('same-render repeated saves run once, failure releases lock, retry succeeds', async () => {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const { useSaveAction } = require('../src/lib/useSaveAction.ts');
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let save;
  function Harness() { save = useSaveAction(); return null; }
  let root;
  await act(async () => { root = create(React.createElement(Harness)); });
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const action = async () => { calls++; await pending; };
  let first;
  await act(async () => {
    first = save.run(action);
    await save.run(action);
  });
  assert.equal(calls, 1);
  assert.equal(save.busy, true);
  await act(async () => { release(); await first; });
  assert.equal(save.busy, false);
  await act(async () => { await save.run(async () => { throw new Error('disk full'); }); });
  assert.equal(save.failed, true);
  assert.equal(save.busy, false);
  await act(async () => { await save.run(async () => { calls++; }); });
  assert.equal(save.failed, false);
  assert.equal(calls, 2);
  await act(async () => root.unmount());
});

test('quantity input accepts Hindi digits and loose quantities but rejects invalid and fractional packs', () => {
  const { parseQuantity } = require('../src/lib/quantity.ts');
  assert.equal(parseQuantity('०.२५', 'kg'), 0.25);
  assert.equal(parseQuantity('0.1', 'ltr'), 0.1);
  assert.equal(parseQuantity('12', 'pkt'), 12);
  for (const value of ['', '-1', '0', 'Infinity', '1e3', '0.001', '1,5']) assert.equal(parseQuantity(value, 'kg'), null);
  assert.equal(parseQuantity('0.5', 'pkt'), null);
});

test('250g sale bills a quarter price and deducts a quarter kilo', async () => {
  const product = await saveProduct('quantity-shop', {
    nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 3,
    sellPrice: 45, buyPrice: 40, lowStockAt: 1,
  });
  const sale = await recordSale({ shopId: 'quantity-shop', lines: [{ product, qty: 0.25 }], payment: 'cash' });
  assert.equal(sale.total, 11.25);
  assert.equal(sale.cost, 10);
  assert.equal((await db.products.get(product.id)).qty, 2.75);
});

test('draft survives database reopen, stays shop-scoped, and clears only with a committed sale', async () => {
  const { emptySaleDraft, saveSaleDraft } = require('../src/lib/saleDraft.ts');
  const product = await saveProduct('draft-shop', {
    nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 3,
    sellPrice: 40, buyPrice: 30, lowStockAt: 1,
  });
  const draft = { ...emptySaleDraft('draft-shop'), cart: { [product.id]: 0.25 }, payment: 'credit', newCust: { name: 'Draft customer', phone: '9999999999' } };
  await saveSaleDraft(draft);
  const other = emptySaleDraft('other-draft-shop');
  await saveSaleDraft(other);
  db.close();
  await db.open();
  assert.deepEqual(await db.saleDrafts.get('draft-shop'), draft);
  const input = { shopId: 'draft-shop', draftId: draft.id, lines: [{ product, qty: 0.25 }], payment: 'credit', newCustomer: draft.newCust };
  const fail = () => { throw new Error('Simulated failure'); };
  db.ledger.hook('creating', fail);
  try { await assert.rejects(recordSale(input), /Simulated/); }
  finally { db.ledger.hook('creating').unsubscribe(fail); }
  assert.deepEqual(await db.saleDrafts.get('draft-shop'), draft);
  const sale = await recordSale(input);
  assert.equal(await db.saleDrafts.get('draft-shop'), undefined);
  assert.deepEqual(await db.saleDrafts.get('other-draft-shop'), other);
  assert.equal((await recordSale(input)).id, sale.id);
  assert.equal((await db.products.get(product.id)).qty, 2.75);
  assert.equal((await db.customers.get(sale.customerId)).balance, 10);
  await saveSaleDraft(draft);
  assert.equal(await db.saleDrafts.get('draft-shop'), undefined, 'late writes cannot revive a completed bill');
  await saveSaleDraft(emptySaleDraft('other-draft-shop'));
  assert.deepEqual((await db.saleDrafts.get('other-draft-shop')).cart, {});
});

test('rapid cart and customer edits survive editor unmount and restore together', async () => {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const { useSaleDraft } = require('../src/lib/useSaleDraft.ts');
  const { emptySaleDraft } = require('../src/lib/saleDraft.ts');
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let editor;
  function Harness({ initial }) { editor = useSaleDraft(initial); return null; }
  let root;
  await act(async () => { root = create(React.createElement(Harness, { initial: emptySaleDraft('navigation-shop') })); });
  await act(async () => {
    editor.update((d) => ({ ...d, cart: { sugar: 0.25 } }));
    editor.update((d) => ({ ...d, payment: 'credit', customerId: 'existing-customer' }));
    root.unmount();
  });
  const restored = await db.saleDrafts.get('navigation-shop');
  assert.deepEqual(restored.cart, { sugar: 0.25 });
  assert.equal(restored.payment, 'credit');
  assert.equal(restored.customerId, 'existing-customer');
  await act(async () => { root = create(React.createElement(Harness, { initial: restored })); });
  assert.deepEqual(editor.draft, restored);
  await act(async () => root.unmount());
});

after(async () => { await db.delete(); });
