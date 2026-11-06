/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { createTranslator } = require('use-intl/core');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const { receiptHtml } = require('../src/lib/receipt.ts');
const { formatINR } = require('../src/lib/money.ts');
const shop = { name: 'Test Shop', phone: '9876543210', ownerId: 'private-owner-id' };
const sale = {
  id: 'abc123-test', total: 100, cost: 71.23, payment: 'cash', createdAt: Date.UTC(2026, 10, 1, 10),
  items: [{ nameHi: 'चावल', nameEn: 'Rice', qty: 1, unit: 'kg', price: 100, cost: 71.23 }],
};
function render(overrides = {}, locale = 'en', extra = {}) {
  const t = createTranslator({ locale, messages: require(`../src/messages/${locale}.json`), onError: e => { throw e; } });
  return receiptHtml(t, { sale: { ...sale, ...overrides }, shop, locale, format: 'a4', ...extra });
}

test('old cash bills print in both languages without leaking private cost/account data', () => {
  for (const locale of ['hi', 'en']) {
    const html = render({}, locale);
    assert.match(html, new RegExp(`lang="${locale}"`));
    assert.ok(html.includes(locale === 'hi' ? 'चावल' : 'Rice'));
    assert.match(html, /ABC123/);
    assert.ok(html.includes(formatINR(100)));
    assert.ok(!html.includes('71.23'));
    assert.ok(!html.includes('private-owner-id'));
    assert.ok(html.includes(locale === 'hi' ? 'GST टैक्स इनवॉइस नहीं' : 'not a GST tax invoice'));
  }
});

test('split receipts distinguish pending UPI, credit and cash change', () => {
  const html = render({ payment: 'split', payments: [
    { method: 'cash', amount: 30, tendered: 50, change: 20 },
    { method: 'upi', amount: 50, status: 'pending' },
    { method: 'credit', amount: 20 },
  ] });
  assert.match(html, /UPI — not yet received/);
  assert.ok(html.includes(formatINR(50)));
  assert.match(html, /Change|change/);
});

test('amount-based loose sales preserve the actual amount and show returned quantity/net', () => {
  const html = render({ total: 20, returnedTotal: 10, items: [
    { ...sale.items[0], qty: 0.44, price: 45, amount: 20, returnedQty: 0.22 },
  ] });
  assert.ok(html.includes(formatINR(20)));
  assert.ok(html.includes(formatINR(10)));
  assert.ok(!html.includes(formatINR(19.8)));
  assert.match(html, /Returned: 220/);
  assert.match(html, /fixed amount/);
});

test('cancelled bills show status, zero net and actual refund routes', () => {
  const html = render({ status: 'cancelled', returnedTotal: 100 }, 'en', { corrections: [
    { createdAt: sale.createdAt, amount: 100, refundMethod: 'cash', refunds: [{ method: 'cash', amount: 60 }, { method: 'upiPending', amount: 40 }] },
  ] });
  assert.match(html, /[Cc]ancelled/);
  assert.ok(html.includes(formatINR(0)));
  assert.ok(html.includes(formatINR(60)));
  assert.ok(html.includes(formatINR(40)));
  assert.match(html, /Returns \/ credit reductions/);
});

test('untrusted names cannot inject markup or resources; all paper formats stay offline', () => {
  for (const format of ['a4', '80mm', '58mm']) {
    const html = render({ items: [{ ...sale.items[0], nameEn: '<img src=x onerror=alert(1)>' }] }, 'en', {
      shop: { ...shop, name: '</title><script>alert(1)</script>' },
      customer: { name: 'A & "B" <iframe>' }, format,
    });
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<iframe>'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /A &amp; &quot;B&quot; &lt;iframe&gt;/);
    assert.ok(!/https?:\/\//.test(html));
    assert.ok(html.includes(format === 'a4' ? 'size: A4' : `max-width: ${format === '80mm' ? '76mm' : '54mm'}`));
  }
});
