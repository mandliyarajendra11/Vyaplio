/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Mobile readability guard rails: WCAG AA contrast of the theme's text/background tokens (computed
// from globals.css), no low-contrast or small-target classes creeping back into components, native
// search clear hidden, reduced motion respected, keyboard-aware viewport.
// Run: node tests/readability.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');
const vars = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q);
  return (y + 0.05) / (x + 0.05);
};
const mix = (fg, bg, a) => '#' + [1, 3, 5].map((i) => Math.round(a * parseInt(fg.slice(i, i + 2), 16) + (1 - a) * parseInt(bg.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');

test('theme text colours meet WCAG AA on the backgrounds they are used on', () => {
  const v = (k) => { assert.ok(vars[k], `--${k} defined`); return vars[k]; };
  const bodyText = ['ink', 'ink-soft', 'teal', 'teal-deep', 'brick', 'leaf', 'mustard-ink'];
  for (const fg of bodyText) for (const bg of ['paper', 'paper-2', 'card']) {
    const r = ratio(v(fg), v(bg));
    assert.ok(r >= 4.5, `--${fg} on --${bg}: ${r.toFixed(2)}`);
  }
  for (const bg of ['paper', 'paper-2', 'card']) assert.ok(ratio(v('mustard-strong'), v(bg)) >= 3, `mustard-strong (large text) on ${bg}`);
  // Light text on filled buttons / badges.
  for (const bg of ['teal', 'teal-deep', 'brick', 'leaf']) assert.ok(ratio(v('paper'), v(bg)) >= 4.5, `paper on --${bg}`);
  assert.ok(ratio('#ffffff', v('wa')) >= 4.5, 'white on WhatsApp green');
  assert.ok(ratio(v('wa'), v('card')) >= 4.5, 'WhatsApp green link text on card');
  assert.ok(ratio(v('ink'), v('mustard')) >= 4.5, 'ink on mustard (primary button)');
  // Tinted badges: brick / leaf text on their own 10–15% tint.
  for (const k of ['brick', 'leaf']) for (const a of [0.1, 0.15]) assert.ok(ratio(v(k), mix(v(k), v('paper'), a)) >= 4.5, `${k} on ${k}/${a * 100}`);
  assert.ok(ratio(v('mustard-ink'), v('mustard-soft')) >= 4.5, 'mustard-ink on mustard-soft');
  // Disabled buttons: ink-soft on paper-2.
  assert.match(css, /\.btn:disabled\s*\{[^}]*background: var\(--paper-2\)[^}]*color: var\(--ink-soft\)/);
});

const tsx = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (p.endsWith('.tsx')) tsx.push([path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
  }
})(path.join(ROOT, 'src'));

test('components: no low-contrast text classes, 48px targets, no hidden horizontal chip scrollers', () => {
  const bad = [];
  for (const [f, s] of tsx) {
    for (const [re, why] of [
      [/text-mustard-deep\b/, 'mustard-deep text (2.9:1) – use text-mustard-ink'],
      [/text-\[#1f8f4e\]/, 'old WhatsApp green text – use text-wa'],
      [/min-h-\[(?:3\d|4[0-7])px\]|min-h-(?:9|10|11)\b/, 'tap target under 48px'],
      [/overflow-x-auto/, 'horizontal scroller – wrap instead'],
      [/\btext-(?:ink|ink-soft|paper)[^"`]*\bopacity-(?:[1-7]\d)\b/, 'faded text'],
    ]) if (re.test(s)) bad.push(`${f}: ${why}`);
  }
  assert.deepEqual(bad, []);
});

test('search clear, reduced motion, rem font sizes, keyboard-aware viewport, safe areas', () => {
  assert.match(css, /input\[type="search"\]::-webkit-search-cancel-button[^{]*\{[^}]*display: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.001ms/);
  assert.match(css, /body \{[^}]*font-size: 1\.0625rem/);
  assert.doesNotMatch(css.match(/body \{[^}]*\}/)[0], /font-size: \d+px/);
  assert.match(css, /:focus-visible \{\s*outline: 3px solid/);
  const layout = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
  assert.match(layout, /interactiveWidget: "resizes-content"/);
  assert.match(layout, /viewportFit: "cover"/);
  const sheet = fs.readFileSync(path.join(ROOT, 'src/components/Sheet.tsx'), 'utf8');
  assert.match(sheet, /safe-area-inset-bottom/);
  assert.match(sheet, /scrollIntoView/);
  const shell = fs.readFileSync(path.join(ROOT, 'src/components/AppShell.tsx'), 'utf8');
  assert.match(shell, /safe-area-inset-left/);
  assert.match(shell, /grid-cols-5/);
});
