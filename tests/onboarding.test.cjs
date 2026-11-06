/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Simpler onboarding: assisted-setup state machine (one question per step, skip defaults,
// validation, resume), starter lists from the alias catalogue, shop creation in one transaction,
// the local PIN (PBKDF2 salted hash, never plaintext; verify; attempt counter + backoff that
// survives a reload; forgot-PIN via the account password without touching data), background
// re-lock timing, "who" names, backup reminder, the secret-free recovery card, and migration of
// existing accounts (no re-setup, no lock, nothing rewritten).
// Run: node tests/onboarding.test.cjs
process.env.TZ = 'Asia/Kolkata';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const Dexie = require('dexie').default ?? require('dexie');
const { createTranslator } = require('use-intl/core');
globalThis.WebSocket ??= class {};

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  module._compile(outputText, filename);
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const SRC = path.join(__dirname, '..', 'src') + path.sep;
function loadPhone(factory) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  Dexie.dependencies.indexedDB = factory ?? new IDBFactory();
  return {
    ...require('../src/lib/db.ts'),
    ...require('../src/lib/ops.ts'),
    ...require('../src/lib/auth.ts'),
    pin: require('../src/lib/pin.ts'),
    ob: require('../src/lib/onboarding.ts'),
    st: require('../src/lib/starter.ts'),
    setup: require('../src/lib/setupShop.ts'),
    br: require('../src/lib/backupReminder.ts'),
    meta: require('../src/lib/meta.ts'),
  };
}
const msgs = (l) => JSON.parse(fs.readFileSync(path.join(SRC, 'messages', `${l}.json`), 'utf8'));
const DAY = 86_400_000;

test('a fresh phone cannot open a shop with the former public demo login', async () => {
  const phone = loadPhone();
  await assert.rejects(phone.login('demo@dukaanmitra.in', 'demo1234'), (error) => error.code === 'invalid');
  assert.equal(await phone.db.users.count(), 0);
  assert.equal(await phone.db.shops.count(), 0);
});

test('onboarding state machine: order, progress, next/back/skip, defaults, validation', () => {
  const { ob } = loadPhone();
  let s = ob.initialState('hi', 1000);
  assert.deepEqual(ob.STEPS, ['language', 'shopName', 'ownerName', 'phone', 'shopType', 'products', 'upi', 'pin', 'safety']);
  assert.equal(s.step, 'language');
  assert.deepEqual(ob.progress(s), { index: 1, total: 9 });
  s = ob.next(s, { language: 'en' }).state;
  assert.equal(s.step, 'shopName');
  assert.equal(s.data.language, 'en');
  // shop name: too short is refused, the answer is kept, the step does not move
  let r = ob.next(s, { shopName: ' A ' });
  assert.equal(r.error, 'shopNameShort');
  assert.equal(r.state.step, 'shopName');
  assert.equal(r.state.data.shopName, ' A ');
  s = ob.next(r.state, { shopName: 'गुप्ता किराना' }).state;
  s = ob.skip(s); // owner name
  assert.equal(s.step, 'phone');
  assert.deepEqual(s.skipped, ['ownerName']);
  r = ob.next(s, { phone: '12345' });
  assert.equal(r.error, 'phone');
  s = ob.next(s, { phone: '+91 98765-43210' }).state;
  assert.equal(s.step, 'shopType');
  s = ob.back(s);
  assert.equal(s.step, 'phone');
  assert.equal(s.data.phone, '+91 98765-43210', 'answers survive going back');
  s = ob.next(s).state;
  s = ob.skip(s); // shop type -> kirana
  assert.equal(s.data.shopType, 'kirana');
  s = ob.next(s, { picked: { 'चीनी': { price: 45, qty: 20 }, 'नमक': {} } }).state;
  r = ob.next(s, { upiId: 'not a upi' });
  assert.equal(r.error, 'upi');
  s = ob.next(s, { upiId: ' Gupta.Kirana@OKICICI ' }).state;
  assert.equal(s.step, 'pin');
  s = ob.skip(s);
  assert.equal(s.step, 'safety');
  assert.ok(ob.isLast(s));
  assert.equal(ob.next(s).state.step, 'safety', 'cannot run past the last step');
  assert.equal(ob.back(ob.initialState('hi')).step, 'language', 'cannot go before the first');
  // a skipped step answered later is no longer "skipped"
  let t = ob.skip(ob.next(ob.initialState('hi')).state);
  t = ob.next(ob.back(t), { shopName: 'Ram Store' }).state;
  assert.deepEqual(t.skipped, []);

  const shop = ob.toShop(s, { shopId: 's1', ownerId: 'u1' }, 'My Shop', 5000);
  assert.equal(shop.name, 'गुप्ता किराना');
  assert.equal(shop.ownerName, '');
  assert.equal(shop.phone, '9876543210');
  assert.equal(shop.upiId, 'gupta.kirana@okicici');
  assert.equal(shop.language, 'en');
  assert.equal(shop.deadStockDays, 30);
  // all skipped -> sensible defaults
  let all = ob.initialState('hi');
  while (!ob.isLast(all)) all = ob.skip(all);
  const d = ob.toShop(all, { shopId: 's2', ownerId: 'u1' }, 'मेरी दुकान');
  assert.equal(d.name, 'मेरी दुकान');
  assert.equal(d.phone, undefined);
  assert.equal(d.upiId, undefined);
  assert.equal(all.data.shopType, 'kirana');
  assert.deepEqual(ob.productsFor(all), []);
});

test('phone and UPI validation', () => {
  const { ob } = loadPhone();
  for (const [raw, want] of [['9876543210', '9876543210'], ['+91 98765 43210', '9876543210'], ['09876543210', '9876543210'], ['', ''], ['   ', '']]) assert.equal(ob.cleanPhone(raw), want, raw);
  for (const raw of ['12345', '5876543210', '98765432101', '919876']) assert.equal(ob.cleanPhone(raw), null, raw);
  for (const [raw, want] of [['ramu@okicici', 'ramu@okicici'], ['9876543210@YBL', '9876543210@ybl'], ['shri.ganesh-kirana_1@oksbi', 'shri.ganesh-kirana_1@oksbi'], ['', '']]) assert.equal(ob.cleanUpi(raw), want, raw);
  for (const raw of ['ramu', '@ybl', 'ramu@', 'ra mu@ybl x', 'a@b', 'ramu@1bank', 'ramu@@ybl']) assert.equal(ob.cleanUpi(raw), null, raw);
});

test('draft is saved per account, revived defensively, and resumes at the same step', async () => {
  const { ob, meta } = loadPhone();
  let s = ob.initialState('hi');
  s = ob.next(s).state;
  s = ob.next(s, { shopName: 'शर्मा स्टोर' }).state;
  await ob.saveDraft('u1', s);
  // "app closed": a fresh module load on the same IndexedDB
  const back = await ob.loadDraft('u1');
  assert.equal(back.step, 'ownerName');
  assert.equal(back.data.shopName, 'शर्मा स्टोर');
  assert.equal(await ob.loadDraft('u2'), null, 'other account has no draft');
  await meta.setMeta('onboard:u3', { v: 1, step: 'nope', data: {} });
  assert.equal(await ob.loadDraft('u3'), null, 'damaged draft starts over');
  await meta.setMeta('onboard:u4', { v: 1, step: 'products', data: { shopType: 'xyz', picked: null, language: 'fr' }, skipped: ['bad', 'phone'] });
  const fixed = await ob.loadDraft('u4');
  assert.equal(fixed.data.shopType, 'kirana');
  assert.deepEqual(fixed.data.picked, {});
  assert.equal(fixed.data.language, 'hi');
  assert.deepEqual(fixed.skipped, ['phone']);
  assert.ok(!JSON.stringify(back).match(/pin"\s*:\s*"\d{4}"/), 'no PIN in the draft');
});

test('starter lists come from the alias catalogue with valid units; picked items become products', () => {
  const { st, UNITS } = loadPhone();
  const al = require('../src/lib/aliases.ts');
  assert.deepEqual(st.starterCatalogueGaps(), []);
  for (const type of st.SHOP_TYPES) {
    const list = st.STARTER[type];
    if (type === 'other') assert.equal(list.length, 0);
    else assert.ok(list.length >= 10, `${type}: ${list.length}`);
    assert.equal(new Set(list.map((i) => i[0])).size, list.length, `${type}: no duplicates`);
    for (const [hi, en, unit, low] of list) {
      assert.ok(/[\u0900-\u097F]/.test(hi) && /^[A-Za-z]/.test(en), `${hi}/${en}`);
      assert.ok(UNITS.includes(unit), `${hi}: ${unit}`);
      assert.ok(low > 0);
      assert.ok(al.builtinAliases(hi, en).length >= 2, `${hi} answers to its catalogue names`);
    }
  }
  assert.ok(al.KIRANA_ALIASES.length >= 130);
  const prods = st.starterProducts('kirana', { 'चीनी': { price: 45, qty: 20 }, 'नमक': {}, 'झुनझुना': {}, 'दूध': {} });
  assert.deepEqual(prods.map((p) => p.nameHi), ['चीनी', 'नमक'], 'only items of the chosen type');
  assert.deepEqual(prods[0], { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 20, buyPrice: 0, sellPrice: 45, lowStockAt: 10 });
  assert.equal(prods[1].qty, 0);
  assert.equal(prods[1].sellPrice, 0, 'price can be filled later');
  assert.equal(st.starterProducts('kirana', { 'चीनी': { price: -5, qty: Number.NaN } })[0].sellPrice, 0);
  assert.deepEqual(st.starterProducts('medical', { 'बुखार की गोली': {} })[0].nameEn, 'Paracetamol');
});

test('finishing setup creates shop + starter products + who-name atomically and clears the draft', async () => {
  const p = loadPhone();
  const user = await p.register('owner@example.in', 'secret12');
  let s = p.ob.initialState('hi');
  s = p.ob.next(s).state;
  s = p.ob.next(s, { shopName: 'गुप्ता किराना' }).state;
  s = p.ob.next(s, { ownerName: 'सुरेश गुप्ता' }).state;
  s = p.ob.skip(s);
  s = p.ob.next(s, { shopType: 'kirana' }).state;
  s = p.ob.next(s, { picked: { 'चीनी': { price: 45, qty: 20 }, 'नमक': { price: 28 } } }).state;
  await p.ob.saveDraft(user.id, s);
  const r = await p.setup.finishOnboarding(s, user.id, 'मेरी दुकान');
  assert.equal(r.products, 2);
  const shop = await p.db.shops.where('ownerId').equals(user.id).first();
  assert.equal(shop.name, 'गुप्ता किराना');
  const prods = await p.db.products.where('shopId').equals(shop.id).toArray();
  assert.equal(prods.length, 2);
  const sugar = prods.find((x) => x.nameHi === 'चीनी');
  assert.equal(sugar.qty, 20);
  const moves = await p.db.stockMoves.where('productId').equals(sugar.id).toArray();
  assert.deepEqual(moves.map((m) => [m.reason, m.delta]), [['opening', 20]]);
  assert.equal((await p.db.stockMoves.where('shopId').equals(shop.id).count()), 1, 'no zero opening move for salt');
  assert.equal((await p.db.users.get(user.id)).displayName, 'सुरेश गुप्ता');
  assert.equal(await p.ob.loadDraft(user.id), null, 'draft cleared');
  const tables = new Set((await p.db.outbox.toArray()).map((o) => o.table));
  assert.ok(tables.has('shops') && tables.has('products') && tables.has('stock_moves'), 'queued for cloud sync');
  // a second finish (double tap / second tab) changes nothing
  const before = await p.db.products.count();
  await assert.rejects(p.setup.finishOnboarding(s, user.id, 'x'));
  assert.equal(await p.db.shops.where('ownerId').equals(user.id).count(), 1);
  assert.equal(await p.db.products.count(), before);
});

test('PIN: salted PBKDF2 hash only, verify, wrong-attempt backoff that survives reload, lock-after', async () => {
  const factory = new IDBFactory();
  let p = loadPhone(factory);
  const { pin } = p;
  assert.equal(pin.backoffMs(0), 0);
  assert.equal(pin.backoffMs(4), 0);
  assert.equal(pin.backoffMs(5), 30_000);
  assert.equal(pin.backoffMs(6), 60_000);
  assert.equal(pin.backoffMs(7), 120_000);
  assert.equal(pin.backoffMs(40), 15 * 60_000, 'capped');
  await assert.rejects(pin.setPin('u1', '12a4'), (e) => e.code === 'format');
  await assert.rejects(pin.setPin('u1', '12345'), (e) => e.code === 'format');
  const rec = await pin.setPin('u1', '4821', { now: 1 });
  const stored = (await p.db.meta.get('pin:u1')).value;
  const json = JSON.stringify(stored);
  assert.ok(!json.includes('4821'), 'PIN never stored in plain text');
  assert.equal(stored.iterations, 150_000);
  assert.equal(Buffer.from(stored.salt, 'base64').length, 16);
  assert.equal(Buffer.from(stored.hash, 'base64').length, 32);
  // same PIN, new salt -> different hash
  const rec2 = await pin.setPin('u2', '4821');
  assert.notEqual(rec.salt, rec2.salt);
  assert.notEqual(rec.hash, rec2.hash);
  // independent check of the hash with node's PBKDF2
  const nodeHash = require('node:crypto').pbkdf2Sync('4821', Buffer.from(stored.salt, 'base64'), 150_000, 32, 'sha256').toString('base64');
  assert.equal(stored.hash, nodeHash);

  assert.deepEqual(await pin.verifyPin('u1', '4821', 10), { ok: true });
  let now = 100;
  for (let i = 1; i <= 4; i++) {
    const r = await pin.verifyPin('u1', '0000', now);
    assert.equal(r.ok, false);
    assert.equal(r.waitMs, 0);
    assert.equal(r.attemptsLeft, 5 - i);
  }
  let r = await pin.verifyPin('u1', '1111', now);
  assert.equal(r.waitMs, 30_000);
  // reload of the app: counters come from disk
  p = loadPhone(factory);
  r = await p.pin.verifyPin('u1', '4821', now + 1000);
  assert.equal(r.ok, false, 'even the right PIN is not tested during the wait');
  assert.equal(r.reason, 'wait');
  assert.equal(await p.pin.pinWaitMs('u1', now + 1000), 29_000);
  now += 30_001;
  r = await p.pin.verifyPin('u1', '2222', now);
  assert.equal(r.waitMs, 60_000, 'doubles after the next mistake');
  now += 60_001;
  assert.deepEqual(await p.pin.verifyPin('u1', '4821', now), { ok: true });
  assert.equal((await p.pin.getPinRecord('u1')).failed, 0, 'counter reset after success');
  assert.equal((await p.pin.verifyPin('nobody', '1234')).reason, 'none');

  await p.pin.setLockAfter('u1', 5);
  assert.equal((await p.pin.getPinRecord('u1')).lockAfterMin, 5);
  await p.pin.setPin('u1', '9999');
  assert.equal((await p.pin.getPinRecord('u1')).lockAfterMin, 5, 'changing the PIN keeps the setting');
  await p.pin.removePin('u1');
  assert.equal(await p.pin.hasPin('u1'), false);
  assert.equal(await p.pin.hasPin('u2'), true, 'per account');
});

test('background re-lock timing', () => {
  const lock = require('../src/lib/lock.ts');
  assert.equal(lock.shouldRelock(null, 10_000, 0), false, 'never hidden');
  assert.equal(lock.shouldRelock(1000, 1000, 0), true, '0 = as soon as the app is left');
  assert.equal(lock.shouldRelock(0, 59_999, 1), false);
  assert.equal(lock.shouldRelock(0, 60_000, 1), true);
  assert.equal(lock.shouldRelock(0, 14 * 60_000, 15), false);
});

test('forgot PIN: account password removes only the PIN; wrong password changes nothing', async () => {
  const p = loadPhone();
  const user = await p.register('owner@example.in', 'secret12');
  await p.db.shops.add({ id: 's1', ownerId: user.id, name: 'Shop', ownerName: '', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: 1, updatedAt: 1 });
  await p.saveProduct('s1', { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 5, buyPrice: 40, sellPrice: 45, lowStockAt: 2 });
  await p.pin.setPin(user.id, '1357');
  const snapshot = async () => JSON.stringify([await p.db.shops.toArray(), await p.db.products.toArray(), await p.db.stockMoves.toArray(), await p.db.users.toArray()]);
  const before = await snapshot();
  assert.equal(await p.verifyPassword(user.id, 'wrong'), false);
  assert.equal(await p.verifyPassword(user.id, ''), false);
  assert.equal(await p.verifyPassword('nobody', 'secret12'), false);
  assert.equal(await p.pin.hasPin(user.id), true);
  assert.equal(await snapshot(), before, 'wrong password: nothing changed');
  assert.equal(await p.verifyPassword(user.id, 'secret12'), true);
  await p.pin.removePin(user.id);
  assert.equal(await p.pin.hasPin(user.id), false);
  assert.equal(await snapshot(), before, 'shop data untouched by the reset');
});

test('who: own name, then owner name, then email — never the shop name', () => {
  const { actorName } = require('../src/lib/actor.ts');
  const shop = { ownerName: 'रमेश शर्मा', name: 'शर्मा किराना' };
  assert.equal(actorName({ email: 'a@b.in', displayName: 'सुरेश' }, shop), 'सुरेश');
  assert.equal(actorName({ email: 'a@b.in', displayName: '  ' }, shop), 'रमेश शर्मा');
  assert.equal(actorName({ email: 'ramu.k@b.in' }, { ownerName: '', name: 'X Store' }), 'ramu.k');
  assert.equal(actorName(null, { ownerName: '', name: 'X Store' }), '—');
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  assert.doesNotMatch(src('components/BillSheet.tsx'), /byName:\s*shop\./);
  assert.doesNotMatch(src('app/(shop)/galla/page.tsx'), /byName\s*=\s*shop\./);
});

test('backup reminder: file or cloud counts, due after N days, demo never, snooze one day', async () => {
  const p = loadPhone();
  const now = 100 * DAY;
  const base = { shopCreatedAt: now - 30 * DAY, remindDays: 7, now };
  assert.deepEqual(p.br.backupState(base), { lastAt: null, via: null, days: 30, due: true });
  assert.equal(p.br.backupState({ ...base, shopCreatedAt: now - 2 * DAY }).due, false, 'new shop: not yet');
  assert.equal(p.br.backupState({ ...base, isDemo: true }).due, false);
  assert.deepEqual(p.br.backupState({ ...base, lastFileAt: now - 3 * DAY }), { lastAt: now - 3 * DAY, via: 'file', days: 3, due: false });
  assert.equal(p.br.backupState({ ...base, lastFileAt: now - 9 * DAY, lastCloudAt: now - DAY }).via, 'cloud');
  assert.equal(p.br.backupState({ ...base, lastFileAt: now - 8 * DAY }).due, true);
  assert.equal(p.br.backupState({ ...base, snoozedUntil: now + 1 }).due, false);

  const shop = { id: 's1', createdAt: now - 20 * DAY };
  let s = await p.br.loadBackupState(shop, now);
  assert.equal(s.due, true);
  assert.equal(s.remindDays, 7);
  await p.br.setRemindDays('s1', 30);
  assert.equal((await p.br.loadBackupState(shop, now)).due, false);
  await p.br.setRemindDays('s1', 3);
  await p.br.markBackup('s1', now - DAY);
  s = await p.br.loadBackupState(shop, now);
  assert.deepEqual([s.due, s.via, s.days], [false, 'file', 1]);
  await p.br.snoozeReminder('s1', now);
  s = await p.br.loadBackupState(shop, now + 5 * DAY);
  assert.equal(s.due, true, 'snooze is one day only');
});

test('recovery card: shop, ids, where backups are — and no secrets', () => {
  const { recoveryCardText } = require('../src/lib/recoveryCard.ts');
  for (const l of ['hi', 'en']) {
    const t = createTranslator({ locale: l, messages: msgs(l), namespace: 'recoveryMore' });
    const txt = recoveryCardText(t, { shopName: 'गुप्ता किराना', shopId: 'abc-123', ownerName: 'सुरेश', accountEmail: 'owner@example.in', cloudEmail: null, lastBackup: '20 Oct 2026', lastBackupVia: 'file' });
    for (const s of ['गुप्ता किराना', 'abc-123', 'owner@example.in', '20 Oct 2026']) assert.ok(txt.includes(s), `${l}: ${s}`);
    assert.doesNotMatch(txt, /secret12|4821|passHash|@ybl|@okicici/);
    const cloud = recoveryCardText(t, { shopName: 'S', shopId: 'x', cloudEmail: 'c@cloud.in', lastBackup: null });
    assert.ok(cloud.includes('c@cloud.in'));
    assert.ok(cloud.includes(t('cardNever')));
  }
});

test('Hindi + English strings: same keys, no empty text', () => {
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  const hi = msgs('hi');
  const en = msgs('en');
  for (const ns of ['onboard', 'pin', 'nudge', 'recoveryMore']) {
    assert.deepEqual(keys(hi[ns]).sort(), keys(en[ns]).sort(), ns);
    for (const k of keys(hi[ns])) assert.ok(String(k.split('.').reduce((o, x) => o[x], hi[ns])).trim(), `${ns}.${k}`);
  }
  for (const s of require('../src/lib/onboarding.ts').STEPS) assert.ok(hi.onboard.q[s] && hi.onboard.h[s] && en.onboard.q[s], s);
  for (const s of require('../src/lib/starter.ts').SHOP_TYPES) assert.ok(hi.onboard.type[s] && en.onboard.type[s], s);
  assert.match(hi.onboard.welcomeTitle, /[\u0900-\u097F]/);
});

test('existing accounts migrate without re-setup, lock or data rewrite', async () => {
  // A phone from before this version: account + shop, no meta rows for PIN / draft / backups.
  const factory = new IDBFactory();
  let p = loadPhone(factory);
  const user = await p.register('old@example.in', 'oldpass1');
  await p.db.shops.add({ id: 'old', ownerId: user.id, name: 'पुरानी दुकान', ownerName: 'रामलाल', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: Date.now() - 60 * DAY, updatedAt: 1 });
  await p.saveProduct('old', { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 5, buyPrice: 40, sellPrice: 45, lowStockAt: 2 });
  const before = JSON.stringify([await p.db.shops.toArray(), await p.db.products.toArray(), await p.db.users.toArray()]);
  p = loadPhone(factory); // new app version opens the same database
  assert.equal(p.db.verno, 10, 'onboarding needed no schema change (v8 = supplier diary, v9 = repeat orders tables, v10 = product kind)');
  assert.equal(JSON.stringify([await p.db.shops.toArray(), await p.db.products.toArray(), await p.db.users.toArray()]), before);
  assert.equal(await p.pin.hasPin(user.id), false, 'no lock until the owner sets a PIN');
  assert.equal(await p.ob.loadDraft(user.id), null, 'setup never shown again (the shop exists)');
  const { actorName } = require('../src/lib/actor.ts');
  assert.equal(actorName(await p.db.users.get(user.id), (await p.db.shops.get('old'))), 'रामलाल', 'who = owner name for old accounts');
  assert.equal((await p.br.loadBackupState(await p.db.shops.get('old'))).due, true, 'old shop without a backup gets the nudge');
  assert.equal((await p.login('old@example.in', 'oldpass1')).id, user.id, 'existing sign-in still works');
});
