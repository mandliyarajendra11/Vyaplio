/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  module._compile(outputText, filename);
};
const { DEFAULT_SALES_WHATSAPP, PLANS, planEnquiry, salesWhatsAppNumber } = require('../src/lib/pricing.ts');

test('the public offer has exactly the agreed yearly and lifetime prices', () => {
  assert.deepEqual(PLANS.map((p) => [p.id, p.rupees, p.period]), [['yearly', 2999, 'year'], ['lifetime', 11000, 'once']]);
  assert.match(planEnquiry('yearly', 'hi'), /₹2,999 साल में/);
  assert.match(planEnquiry('lifetime', 'en'), /₹11,000 lifetime/);
  assert.equal(salesWhatsAppNumber(undefined), null);
  assert.equal(salesWhatsAppNumber('+91 98765 43210'), '919876543210');
  assert.equal(salesWhatsAppNumber('abc123'), null);
  assert.equal(salesWhatsAppNumber(DEFAULT_SALES_WHATSAPP), '919993904447');
});
