/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Offline: queued changes survive until the server accepts them; the service worker finds every asset.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('fake-indexeddb/auto');

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};

// No Supabase keys: the app stays fully local and the queue is kept untouched.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: online }) });

const { db } = require('../src/lib/db.ts');
const { recordSale, saveProduct } = require('../src/lib/ops.ts');
const { syncNow, pendingCount } = require('../src/lib/sync.ts');

const SHOP = 'offline-shop';

test('no cloud keys: sales work, changes stay queued, sync reports "not configured" honestly', async () => {
  online = false;
  const p = await saveProduct(SHOP, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 10, sellPrice: 45, buyPrice: 40, lowStockAt: 1 });
  await recordSale({ shopId: SHOP, payment: 'cash', lines: [{ product: p, qty: 1 }] });
  const queued = await pendingCount(SHOP);
  assert.ok(queued >= 4, 'product + opening stock + sale + stock change queued');
  assert.equal((await db.products.get(p.id)).qty, 9);
  const moves = await db.stockMoves.where('productId').equals(p.id).toArray();
  assert.deepEqual(moves.map((m) => m.delta).sort(), [-1, 10]);

  online = true;
  const [a, b] = await Promise.all([syncNow(), syncNow()]);
  assert.equal(a, b, 'overlapping triggers share one run');
  assert.equal(a.skipped, true);
  assert.equal(a.reason, 'notConfigured');
  assert.equal(await pendingCount(SHOP), queued, 'nothing dropped');
  assert.equal(await db.meta.get('syncStatus'), undefined, 'no fake "synced" status');
});

test('service worker asset crawl finds chunks, lazy chunks and CSS fonts', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const ctx = { self: { location: { origin: 'http://shop.test' }, addEventListener() {} }, URL, TextEncoder, crypto: globalThis.crypto, console };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.extractAssets = extractAssets; this.routeKey = routeKey;', ctx);
  const html = '<script src="/_next/static/chunks/0abc.js" async></script><link rel="stylesheet" href="/_next/static/chunks/1v59.css">' +
    '<link rel="preload" href="/_next/static/media/32c8-s.p.2dq.woff2" as="font">self.__next_f.push([1,"static/chunks/lazy_1.js"])';
  assert.deepEqual([...ctx.extractAssets(html, 'http://shop.test/sale')].sort(), [
    '/_next/static/chunks/0abc.js', '/_next/static/chunks/1v59.css', '/_next/static/chunks/lazy_1.js', '/_next/static/media/32c8-s.p.2dq.woff2',
  ]);
  const css = '@font-face{src:url(../media/a07f-s.1ni.woff2) format("woff2")}.x{background:url(data:image/png;base64,AA)}.y{filter:url(#n)}.z{mask:url(%23n)}';
  assert.deepEqual([...ctx.extractAssets(css, 'http://shop.test/_next/static/chunks/1v59.css')], ['/_next/static/media/a07f-s.1ni.woff2']);
  assert.equal(ctx.routeKey('/sale/'), '/sale');
  assert.equal(ctx.routeKey('/'), '/');
  assert.equal(ctx.routeKey('/nope'), null);
});
