/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness. */
// Hindi search + voice: Devanagari <-> Roman phonetic keys, built-in and per-product aliases,
// ranking (exact > prefix > alias > fuzzy, best-sellers break ties) on 1500 products, spoken
// quantities ("do kilo chini", "ढाई सौ ग्राम"), the speech recogniser wrapper with every error path
// (mocked SpeechRecognition), bill item search, and custom aliases through sync + backup.
// Run: node tests/hindi-search.test.cjs
process.env.TZ = 'Asia/Kolkata';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const ts = require('typescript');
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const Dexie = require('dexie').default ?? require('dexie');
const { createTranslator } = require('use-intl/core');
globalThis.WebSocket ??= class {};

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const SRC = path.join(__dirname, '..', 'src') + path.sep;
function loadPhone() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  Dexie.dependencies.indexedDB = new IDBFactory();
  return {
    ...require('../src/lib/db.ts'),
    ...require('../src/lib/ops.ts'),
    ...require('../src/lib/backup.ts'),
    ...require('../src/lib/bills.ts'),
    ...require('../src/lib/syncSchema.ts'),
  };
}
const tr = require('../src/lib/translit.ts');
const al = require('../src/lib/aliases.ts');
const se = require('../src/lib/search.ts');
const vp = require('../src/lib/voiceParse.ts');
const vo = require('../src/lib/voice.ts');
const msgs = (l) => JSON.parse(fs.readFileSync(path.join(SRC, 'messages', `${l}.json`), 'utf8'));

test('phonetic keys: Roman spellings and Devanagari meet (matras, nukta, anusvara, aspirates)', () => {
  const same = [
    ['chini', 'cheeni', 'चीनी'], ['shakkar', 'shakar', 'शक्कर'], ['atta', 'aata', 'आटा'], ['dal', 'daal', 'दाल'],
    ['tel', 'तेल'], ['namak', 'नमक'], ['chawal', 'chaawal', 'चावल'], ['sabun', 'साबुन'], ['doodh', 'dudh', 'दूध'],
    ['haldi', 'हल्दी'], ['jeera', 'zeera', 'जीरा'], ['ghee', 'घी'], ['suji', 'sooji', 'सूजी'], ['paneer', 'पनीर'],
    ['moong', 'मूंग'], ['gud', 'गुड़', 'गुड'], ['dhaniya', 'धनिया'], ['chai patti', 'चाय पत्ती'], ['hing', 'हींग'],
    ['saunf', 'सौंफ'], ['kishmish', 'किशमिश'], ['चाँद', 'चांद'], ['बादाम', 'badam'],
  ];
  for (const group of same) {
    const keys = group.map(tr.phoneticKey);
    assert.ok(keys.every((k) => k === keys[0]), `${group.join(' / ')} -> ${keys.join(' / ')}`);
  }
  for (const [a, b] of [['chini', 'namak'], ['dal', 'tel'], ['atta', 'aloo']]) assert.notEqual(tr.phoneticKey(a), tr.phoneticKey(b));
  assert.equal(tr.phoneticKey(tr.romanize('शक्कर')), tr.phoneticKey('shakkar'), 'romanize round trip');
  assert.equal(tr.phoneticKey('१२'), tr.phoneticKey('12'), 'Hindi digits');
  // The few one-letter misses are inside the fuzzy budget.
  for (const [r, d] of [['maggi', 'मैगी'], ['biscuit', 'बिस्कुट'], ['elaichi', 'इलायची']]) assert.ok(tr.editDistance(tr.phoneticKey(r), tr.phoneticKey(d), 2) <= 1, r);
  assert.equal(tr.editDistance('abc', 'xyzabc', 2), 3, 'gives up beyond max');
});

test('built-in aliases (~100 items) and the product form alias list', () => {
  assert.ok(al.KIRANA_ALIASES.length >= 100, `${al.KIRANA_ALIASES.length} entries`);
  for (const e of al.KIRANA_ALIASES) assert.ok(/[\u0900-\u097F]/.test(e[0]) && e.length >= 3, e.join());
  const sugar = al.builtinAliases('चीनी', 'Sugar');
  for (const a of ['shakkar', 'chini', 'cheeni', 'sugar', 'शक्कर']) assert.ok(sugar.includes(a), a);
  assert.ok(al.builtinAliases('Tata नमक', '').includes('salt'), 'a word of the name is enough');
  assert.ok(al.builtinAliases('', 'Maggi Masala Noodles').includes('मैगी'));
  assert.deepEqual(al.builtinAliases('झुनझुना', 'Rattle'), []);
  assert.deepEqual(al.parseAliases(' shakkar, Sugar ,, sugar\n टाटा  नमक ;x'), ['shakkar', 'Sugar', 'टाटा नमक', 'x']);
});

const P = (nameHi, nameEn, salesCount = 0, extra = {}) => ({ id: `${nameEn}-${nameHi}`, nameHi, nameEn, salesCount, unit: 'pcs', ...extra });
const names = (hits) => hits.map((h) => h.product.nameHi);

test('ranking: exact > prefix > contains > alias > fuzzy; best-sellers break ties; Roman <-> Devanagari', () => {
  const list = [
    P('चीनी', 'Sugar', 5, { unit: 'kg' }), P('चिनिया बादाम', 'Peanut', 50), P('मैगी', 'Maggi', 9), P('आटा', 'Atta', 3), P('सरसों तेल', 'Mustard Oil', 4),
    P('नमक', 'Salt', 1), P('चावल', 'Rice', 2), P('साबुन', 'Soap', 1), P('दूध', 'Milk', 8), P('हल्दी', 'Haldi', 1), P('मिर्च', 'Chilli', 1),
    P('चना दाल', 'Chana Dal', 2), P('मूंग दाल', 'Moong Dal', 6), P('Lux साबुन', 'Lux soap', 7, { barcode: '8901030' }),
  ];
  const idx = se.buildIndex(list);
  const top = (q) => se.searchIndex(idx, q)[0]?.product.nameHi;
  assert.equal(top('chini'), 'चीनी');
  assert.equal(top('cheeni'), 'चीनी');
  assert.equal(top('चीनी'), 'चीनी');
  assert.equal(top('shakkar'), 'चीनी', 'alias');
  assert.equal(top('sugar'), 'चीनी');
  assert.equal(top('मैगी'), 'मैगी');
  assert.equal(top('maggi'), 'मैगी');
  assert.equal(top('aata'), 'आटा');
  assert.equal(top('namak'), 'नमक');
  assert.equal(top('chawal'), 'चावल');
  assert.equal(top('rice'), 'चावल');
  assert.equal(top('doodh'), 'दूध');
  assert.equal(top('haldi'), 'हल्दी');
  assert.equal(top('mirchi'), 'मिर्च');
  assert.equal(top('tel'), 'सरसों तेल');
  assert.equal(top('oil'), 'सरसों तेल');
  assert.equal(top('sarson tel'), 'सरसों तेल', 'multi-word');
  assert.equal(top('8901030'), 'Lux साबुन', 'barcode');
  // "sabun": the item named exactly साबुन beats "Lux साबुन" (word match) even though Lux sells more.
  assert.deepEqual(names(se.searchIndex(idx, 'sabun')).slice(0, 2), ['साबुन', 'Lux साबुन']);
  // Same rank -> best-seller first: both dals are word matches for "dal".
  assert.deepEqual(names(se.searchIndex(idx, 'dal')), ['मूंग दाल', 'चना दाल']);
  // Prefix ("chin") ranks the name match above fuzzy neighbours and both "chin…" items by sales.
  const chin = se.searchIndex(idx, 'chin');
  assert.deepEqual(names(chin).slice(0, 2), ['चिनिया बादाम', 'चीनी']);
  assert.equal(chin[0].tier, se.Tier.Prefix);
  // Fuzzy: a typo still finds it, below exact/prefix/alias.
  const typo = se.searchIndex(idx, 'haldee');
  assert.equal(typo[0].product.nameHi, 'हल्दी');
  assert.equal(top('nmak'), 'नमक', 'vowels dropped by the key');
  const fz = se.searchIndex(idx, 'haldu');
  assert.equal(fz[0].product.nameHi, 'हल्दी');
  assert.equal(fz[0].tier, se.Tier.Fuzzy);
  assert.ok(se.Tier.Exact > se.Tier.Prefix && se.Tier.Prefix > se.Tier.Alias && se.Tier.Alias > se.Tier.Fuzzy);
  assert.deepEqual(se.searchIndex(idx, 'xyzzy'), []);
  assert.equal(se.closest(idx, 'xyzzy').length, 3, 'closest always offers something');
  assert.equal(se.searchIndex(idx, '').length, list.length, 'empty query = all, best-sellers first');
  assert.equal(se.searchIndex(idx, '')[0].product.nameHi, 'चिनिया बादाम');
  // Custom alias on a product.
  const own = se.buildIndex([P('पारले-जी', 'Parle-G', 0, { aliases: ['glucose biscuit', 'जी बिस्कुट'] }), P('चीनी', 'Sugar')]);
  assert.equal(se.searchIndex(own, 'glucose')[0].product.nameEn, 'Parle-G');
  assert.equal(se.searchIndex(own, 'glucose')[0].tier, se.Tier.Alias);
  // Bill item matcher (no fuzzy).
  assert.ok(se.itemMatches({ nameHi: 'चीनी', nameEn: 'Sugar' }, 'shakkar'));
  assert.ok(!se.itemMatches({ nameHi: 'चीनी', nameEn: 'Sugar' }, 'tel'));
});

test('fast enough for 1500 products', () => {
  const base = [['चीनी', 'Sugar'], ['मैगी', 'Maggi'], ['आटा', 'Atta'], ['सरसों तेल', 'Mustard oil'], ['नमक', 'Salt'], ['चावल', 'Rice'], ['हल्दी', 'Haldi'], ['साबुन', 'Soap'], ['बिस्कुट', 'Biscuit'], ['दाल', 'Dal']];
  const list = [];
  for (let i = 0; i < 1500; i++) list.push(P(`${base[i % 10][0]} ${i}`, `${base[i % 10][1]} ${i}`, i % 97));
  let t0 = performance.now();
  const idx = se.buildIndex(list);
  const build = performance.now() - t0;
  t0 = performance.now();
  const queries = ['chini', 'cheeni', 'maggi', 'sarson tel', 'haldee', 'xyz', 'oil', 'shakkar', 'बिस्कुट', 'd'];
  for (const q of queries) se.searchIndex(idx, q);
  const per = (performance.now() - t0) / queries.length;
  assert.equal(se.searchIndex(idx, 'chini').length, 150);
  assert.equal(se.searchIndex(idx, 'chini')[0].product.salesCount, 96, 'best-seller first');
  assert.ok(build < 1500 && per < 60, `build ${build.toFixed(0)} ms, ${per.toFixed(1)} ms per search`);
  t0 = performance.now();
  se.buildIndex(list); // re-render: alias keys cached
  assert.ok(performance.now() - t0 < build + 50);
});

test('spoken quantities in Hindi / Roman / English', () => {
  const cases = [
    ['do kilo chini', 2, 'kg', 'chini'], ['दो किलो चीनी', 2, 'kg', 'चीनी'], ['२ किलो चीनी', 2, 'kg', 'चीनी'], ['चीनी दो किलो', 2, 'kg', 'चीनी'],
    ['aadha kilo dal', 0.5, 'kg', 'dal'], ['आधा किलो दाल', 0.5, 'kg', 'दाल'], ['ढाई सौ ग्राम जीरा', 250, 'g', 'जीरा'], ['dhai kilo atta', 2.5, 'kg', 'atta'],
    ['डेढ़ लीटर तेल', 1.5, 'ltr', 'तेल'], ['sava kilo atta', 1.25, 'kg', 'atta'], ['saade teen kilo aloo', 3.5, 'kg', 'aloo'], ['paune do kilo chawal', 1.75, 'kg', 'chawal'],
    ['paav kilo jeera', 0.25, 'kg', 'jeera'], ['3 packet maggi', 3, 'pkt', 'maggi'], ['teen packet maggi', 3, 'pkt', 'maggi'], ['500g haldi', 500, 'g', 'haldi'],
    ['1.5 litre tel', 1.5, 'ltr', 'tel'], ['two kg sugar', 2, 'kg', 'sugar'], ['ek dozen ande', 1, 'dozen', 'ande'], ['दो मैगी', 2, null, 'मैगी'],
    ['maggi teen', 3, null, 'maggi'], ['do sau gram haldi', 200, 'g', 'haldi'], ['पांच पैकेट बिस्कुट', 5, 'pkt', 'बिस्कुट'],
    ['chini', null, null, 'chini'], ['maggi do', null, null, 'maggi'], ['chini de do', null, null, 'chini'], ['दो किलो चीनी दे दो', 2, 'kg', 'चीनी'],
    ['pav', null, null, 'pav'],
  ];
  for (const [text, qty, unit, rest] of cases) {
    const r = vp.parseSpokenQuantity(text);
    assert.deepEqual([r.qty, r.unit, r.rest], [qty, unit, rest], text);
  }
  const money = vp.parseSpokenQuantity('20 rupaye ki chini');
  assert.deepEqual([money.qty, money.rest, money.money], [null, 'chini', true], 'money is not a quantity');
  // Safe for this product?
  const q = vp.qtyForProduct;
  assert.equal(q({ qty: 2, unit: 'kg' }, 'kg'), 2);
  assert.equal(q({ qty: 250, unit: 'g' }, 'kg'), 0.25);
  assert.equal(q({ qty: 500, unit: 'ml' }, 'ltr'), 0.5);
  assert.equal(q({ qty: 2, unit: null }, 'kg'), 2);
  assert.equal(q({ qty: 3, unit: 'pkt' }, 'pcs'), 3, 'packet ~ piece');
  assert.equal(q({ qty: 1, unit: 'dozen' }, 'pcs'), 12);
  assert.equal(q({ qty: 2, unit: 'kg' }, 'pkt'), null, 'weight for a packet item');
  assert.equal(q({ qty: 2, unit: 'pkt' }, 'kg'), null);
  assert.equal(q({ qty: 0.5, unit: null }, 'pcs'), null, 'half a piece');
  assert.equal(q({ qty: 2, unit: 'pcs' }, 'box'), null);
  assert.equal(q({ qty: 2000, unit: null }, 'kg'), null, 'too many');
  assert.equal(q({ qty: null, unit: null }, 'kg'), null);
});

/** A scripted SpeechRecognition: each test says what the "browser" does after start(). */
function mockRecognizer(script, opts = {}) {
  const made = [];
  class FakeRecognition {
    constructor() {
      if (opts.throwOnNew) throw new Error('nope');
      made.push(this);
    }
    start() {
      if (opts.throwOnStart) throw new DOMException('blocked', 'NotAllowedError');
      queueMicrotask(() => script(this));
    }
    stop() { queueMicrotask(() => this.onend?.()); }
    abort() { queueMicrotask(() => { this.onerror?.({ error: 'aborted' }); this.onend?.(); }); }
  }
  return { Ctor: FakeRecognition, made };
}
const result = (transcripts, isFinal) => Object.assign(transcripts.map((t) => ({ transcript: t })), { isFinal });
function run(Ctor, { lang = 'hi-IN', online = true } = {}) {
  return new Promise((resolve) => {
    const out = { interim: [], final: null, error: null, ended: 0 };
    vo.startVoice(Ctor, lang, {
      onInterim: (t) => out.interim.push(t),
      onFinal: (a) => (out.final = a),
      onError: (e) => (out.error = e),
      onEnd: () => { out.ended++; setTimeout(() => resolve(out), 0); },
    }, () => online);
  });
}

test('speech recogniser: language, interim text, final alternatives', async () => {
  const { Ctor, made } = mockRecognizer((r) => {
    r.onresult({ resultIndex: 0, results: [result(['do'], false)] });
    r.onresult({ resultIndex: 0, results: [result(['do kilo'], false)] });
    r.onresult({ resultIndex: 0, results: [result(['do kilo chini.', 'do kilo cheeni', 'दो किलो चीनी'], true)] });
    r.onend();
  });
  const out = await run(Ctor, { lang: 'en-IN' });
  assert.equal(made[0].lang, 'en-IN');
  assert.equal(made[0].interimResults, true);
  assert.equal(made[0].maxAlternatives, 3);
  assert.deepEqual(out.interim, ['do', 'do kilo', 'do kilo chini']);
  assert.deepEqual(out.final, ['do kilo chini', 'do kilo cheeni', 'दो किलो चीनी']);
  assert.equal(out.error, null);
  assert.equal(out.ended, 1);
  // Hinglish result straight into the matcher + quantity parser.
  const said = vp.parseSpokenQuantity(out.final[2]);
  const idx = se.buildIndex([P('चीनी', 'Sugar', 0, { unit: 'kg' }), P('चना', 'Chana')]);
  assert.equal(se.searchIndex(idx, said.rest)[0].product.nameHi, 'चीनी');
  assert.equal(vp.qtyForProduct(said, 'kg'), 2);
  const mixed = vp.parseSpokenQuantity('2 kilo चीनी');
  assert.deepEqual([mixed.qty, mixed.unit, se.searchIndex(idx, mixed.rest)[0].product.nameHi], [2, 'kg', 'चीनी']);
  // Ended with only interim text: use what was shown.
  const onlyInterim = await run(mockRecognizer((r) => { r.onresult({ results: [result(['maggi'], false)] }); r.onend(); }).Ctor);
  assert.deepEqual(onlyInterim.final, ['maggi']);
  assert.equal(vo.voiceLangFor('hi'), 'hi-IN');
  assert.equal(vo.voiceLangFor('en'), 'en-IN');
  assert.equal(vo.getRecognitionCtor(undefined), undefined);
  assert.equal(vo.getRecognitionCtor({}), undefined, 'no API -> mic button hidden');
  assert.equal(vo.getRecognitionCtor({ webkitSpeechRecognition: Ctor }), Ctor, 'Chrome prefix');
});

test('speech recogniser: every failure becomes a reason with hi/en help', async () => {
  const fail = (code) => mockRecognizer((r) => { r.onerror({ error: code }); r.onend(); }).Ctor;
  assert.equal((await run(fail('not-allowed'))).error, 'permission');
  assert.equal((await run(fail('service-not-allowed'))).error, 'unsupported');
  assert.equal((await run(fail('no-speech'))).error, 'noSpeech');
  assert.equal((await run(fail('audio-capture'))).error, 'mic');
  assert.equal((await run(fail('network'))).error, 'network');
  assert.equal((await run(fail('network'), { online: false })).error, 'offline', 'offline: say internet is needed');
  assert.equal((await run(fail('language-not-supported'))).error, 'language');
  assert.equal((await run(fail('something-new'))).error, 'failed');
  assert.equal((await run(mockRecognizer((r) => r.onend()).Ctor)).error, 'noSpeech', 'ended without words');
  assert.equal((await run(mockRecognizer(() => {}, { throwOnNew: true }).Ctor)).error, 'unsupported');
  assert.equal((await run(mockRecognizer(() => {}, { throwOnStart: true }).Ctor)).error, 'unsupported');
  // Aborted (sheet closed / language switched): nothing reported, still ends once.
  const ab = await run(fail('aborted'));
  assert.deepEqual([ab.error, ab.final, ab.ended], [null, null, 1]);
  const { Ctor } = mockRecognizer(() => {});
  const ended = await new Promise((resolve) => {
    let n = 0;
    const s = vo.startVoice(Ctor, 'hi-IN', { onFinal: () => assert.fail(), onError: () => assert.fail(), onEnd: () => { n++; setTimeout(() => resolve(n), 5); } });
    s.abort();
  });
  assert.equal(ended, 1);
  // Messages for every reason, both languages, plus the no-match texts.
  for (const l of ['hi', 'en']) {
    const t = createTranslator({ locale: l, messages: msgs(l) });
    for (const e of ['unsupported', 'permission', 'noSpeech', 'mic', 'network', 'offline', 'language', 'failed']) {
      assert.ok(t(`voice.err_${e}`) && t(`voice.help_${e}`), `${l} ${e}`);
    }
    assert.match(t('voice.noMatch', { text: 'xyz' }), /xyz/);
    assert.match(t('voice.addProduct', { text: 'xyz' }), /xyz/);
  }
  const hi = createTranslator({ locale: 'hi', messages: msgs('hi') });
  assert.match(hi('voice.help_unsupported'), /Chrome/);
  assert.match(hi('voice.help_unsupported'), /Android/);
  assert.match(hi('voice.help_offline'), /इंटरनेट/);
  assert.match(hi('voice.help_permission'), /माइक्रोफ़ोन/);
});

test('custom aliases: saved, searched, kept/cleared on edit, synced and backed up; bill item search', async () => {
  const m = loadPhone();
  const now = Date.now();
  const shop = { id: crypto.randomUUID(), ownerId: 'owner-1', name: 'शर्मा किराना', ownerName: 'रमेश', language: 'hi', deadStockDays: 30, expiryWarnDays: 7, createdAt: now, updatedAt: now };
  await m.db.shops.add(shop);
  const base = { nameHi: 'पारले-जी', nameEn: 'Parle-G', unit: 'pcs', qty: 50, sellPrice: 10, buyPrice: 8, lowStockAt: 5 };
  const p = await m.saveProduct(shop.id, { ...base, aliases: al.parseAliases('glucose biscuit, जी बिस्कुट') });
  const sugar = await m.saveProduct(shop.id, { nameHi: 'चीनी', nameEn: 'Sugar', unit: 'kg', qty: 50, sellPrice: 45, buyPrice: 40, lowStockAt: 5, aliases: [] });
  assert.deepEqual((await m.db.products.get(p.id)).aliases, ['glucose biscuit', 'जी बिस्कुट']);
  const all = await m.db.products.toArray();
  assert.equal(se.searchIndex(se.buildIndex(all), 'glucose')[0].product.id, p.id);
  // Queued for sync with the aliases; remote row has the column; pull brings them back.
  const q = (await m.db.outbox.toArray()).find((o) => o.table === 'products' && o.rowId === p.id);
  assert.deepEqual(q.payload.aliases, ['glucose biscuit', 'जी बिस्कुट']);
  const remote = m.toRemote('products', await m.db.products.get(p.id), 'owner-1');
  assert.deepEqual(remote.aliases, ['glucose biscuit', 'जी बिस्कुट']);
  assert.deepEqual(m.fromRemote('products', remote).aliases, ['glucose biscuit', 'जी बिस्कुट']);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(sql, /aliases jsonb/);
  assert.match(sql, /alter table products add column if not exists aliases jsonb/);
  // Backup round trip + validation.
  const file = await m.createBackup(shop.id);
  const { data } = await m.readBackup(file.text);
  assert.deepEqual(data.products.find((x) => x.id === p.id).aliases, ['glucose biscuit', 'जी बिस्कुट']);
  const bad = JSON.parse(file.text);
  bad.data.products[0].aliases = [42];
  bad.checksum = 'sha256:' + nodeCrypto.createHash('sha256').update(JSON.stringify(bad.data)).digest('hex');
  await assert.rejects(m.readBackup(JSON.stringify(bad)), (e) => e.code === 'invalid');
  // Edit with the field emptied clears them (the form always sends the list).
  await m.saveProduct(shop.id, { ...base, aliases: [] }, p.id);
  assert.deepEqual((await m.db.products.get(p.id)).aliases, []);
  // Bills: item search by Roman / alias.
  await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: sugar, qty: 2 }] });
  await m.recordSale({ shopId: shop.id, payment: 'cash', lines: [{ product: p, qty: 1 }] });
  const f = (text) => m.queryBills(shop.id, { ...m.defaultFilter(Date.now()), q: text }).then((r) => r.bills.map((b) => b.items[0].nameHi));
  assert.deepEqual(await f('chini'), ['चीनी']);
  assert.deepEqual(await f('shakkar'), ['चीनी']);
  assert.deepEqual(await f('cheeni'), ['चीनी']);
  assert.deepEqual(await f('biscuit'), ['पारले-जी'], 'built-in alias via the name word');
  assert.deepEqual(await f('tel'), []);
});
