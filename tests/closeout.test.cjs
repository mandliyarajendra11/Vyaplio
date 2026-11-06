/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createTranslator } = require('use-intl/core');
require('fake-indexeddb/auto');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  module._compile(outputText, filename);
};
const { db } = require('../src/lib/db.ts');
const { computeCashDay, closeDay, loadCashDay } = require('../src/lib/cash.ts');
const { closeoutText } = require('../src/lib/closeout.ts');
const messages = (locale) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'messages', `${locale}.json`), 'utf8'));
const t = createTranslator({ locale: 'hi', messages: messages('hi') });
const day = '2026-11-06';
const shop = { id: 'closeout-shop', name: 'मेरी दुकान', ownerName: 'मीना' };
const alerts = { pendingUpi: [{ pending: 80 }], shortage: [{ id: 'a' }], low: [{ id: 'b' }], expiring: [], dead: [], total: 3 };
const stats = { total: 300, count: 3 };

test('open and closed WhatsApp summaries stay honest about cash, UPI and stock', () => {
  const input = { day, sales: [], corrections: [], ledger: [], entries: [], carried: null };
  const open = computeCashDay(input);
  const text = closeoutText(t, open, shop, 'hi', stats, alerts);
  assert.match(text, /अभी खुला|बंद नहीं|गिनती बाकी/);
  assert.match(text, /UPI पक्का करना बाकी: ₹80/);
  assert.match(text, /स्टॉक जाँचें: 1 गड़बड़/);
  assert.equal((text.match(/— Vyaplio/g) ?? []).length, 1);
  const closed = computeCashDay({ ...input, entries: [{ id: 'close-1', shopId: shop.id, day, kind: 'close', amount: 0, expected: 0, createdAt: Date.now() }] });
  assert.match(closeoutText(t, closed, shop, 'hi', stats, alerts), /गिना: ₹0/);
});

test('simple cash close uses existing ledger and refuses a second close without correction reason', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const closed = await closeDay({ shopId: shop.id, day: today, counted: 0, byName: 'मीना' });
  assert.equal(closed.amount, 0);
  assert.equal((await loadCashDay(shop.id, today)).closed, true);
  await assert.rejects(closeDay({ shopId: shop.id, day: today, counted: 0 }), /reason/);
  await db.delete();
});
