/**
 * Product search for the counter: Hindi / Roman / English, aliases, small typos.
 *
 * Rank: exact name > name prefix > name contains > alias (built-in or the shop's own) > fuzzy
 * (edit distance 1, or 2 for long words, on the phonetic key); best-sellers break ties.
 * Build the index once per product list (useMemo) – each search is then a linear pass over
 * pre-computed keys (fine for a few thousand products).
 */
import { builtinAliases } from "./aliases";
import type { Product } from "./db";
import { editDistance, phoneticKey } from "./translit";

export enum Tier {
  None = 0,
  Fuzzy = 1,
  Alias = 2,
  Contains = 3,
  Prefix = 4,
  Exact = 5,
  Barcode = 6,
}

interface Term {
  text: string; // lower-cased
  key: string; // phonetic key
  words: string[]; // key words
}

export interface IndexedProduct<P> {
  product: P;
  names: Term[];
  aliases: Term[];
  barcode?: string;
  sales: number;
}

type Searchable = Pick<Product, "id" | "nameHi" | "nameEn"> & Partial<Pick<Product, "barcode" | "aliases" | "salesCount" | "supplier">>;

const term = (s: string): Term => {
  const key = phoneticKey(s);
  return { text: s.toLowerCase().normalize("NFC").trim(), key, words: key.split(" ").filter(Boolean) };
};

const termCache = new Map<string, IndexedProduct<Searchable>["aliases"]>();

/** Pre-compute keys for a product list. Cached per name/alias combination, so re-renders are cheap. */
export function buildIndex<P extends Searchable>(products: readonly P[], extra?: (p: P) => (string | undefined)[]): IndexedProduct<P>[] {
  return products.map((p) => {
    const nameList = [p.nameHi, p.nameEn, ...(extra?.(p) ?? [])].filter((x): x is string => !!x && !!x.trim());
    const ck = `${p.nameHi}\u0001${p.nameEn}\u0001${(p.aliases ?? []).join("\u0002")}`;
    let aliases = termCache.get(ck);
    if (!aliases) {
      aliases = [...(p.aliases ?? []), ...builtinAliases(p.nameHi, p.nameEn)].map(term);
      if (termCache.size > 5000) termCache.clear();
      termCache.set(ck, aliases);
    }
    return { product: p, names: nameList.map(term), aliases, barcode: p.barcode, sales: p.salesCount ?? 0 };
  });
}

/** How well one query word matches one term. */
function wordTier(q: string, qk: string, t: Term, isAlias: boolean): Tier {
  if (!qk && !q) return Tier.None;
  const textWords = t.text.split(/\s+/);
  if (t.text === q || (qk && t.key === qk)) return isAlias ? Tier.Alias : Tier.Exact;
  if (t.text.startsWith(q) || textWords.some((w) => w.startsWith(q)) || (qk && t.words.some((w) => w.startsWith(qk)))) return isAlias ? Tier.Alias : Tier.Prefix;
  if (q.length >= 2 && t.text.includes(q)) return isAlias ? Tier.Alias : Tier.Contains;
  if (qk.length >= 3) {
    const max = qk.length >= 6 ? 2 : 1;
    for (const w of t.words) {
      if (editDistance(qk, w, max) <= max) return Tier.Fuzzy;
      // prefix with a typo: "chin" vs "cini..." handled above; "sarso" vs "srson"
      if (w.length > qk.length && editDistance(qk, w.slice(0, qk.length), 1) <= 1 && qk.length >= 4) return Tier.Fuzzy;
    }
  }
  return Tier.None;
}

function termTier(qWords: string[], qKeys: string[], whole: string, wholeKey: string, t: Term, isAlias: boolean): Tier {
  // Whole query first (multi-word names: "sarson tel"), then every word must match somewhere.
  const all = wordTier(whole, wholeKey, t, isAlias);
  if (all >= Tier.Contains || qWords.length === 1) return all;
  let min: Tier = Tier.Exact;
  for (let i = 0; i < qWords.length; i++) {
    const w = wordTier(qWords[i], qKeys[i] ?? "", t, isAlias);
    if (w === Tier.None) return all;
    if (w < min) min = w;
  }
  return Math.max(all, Math.min(min, Tier.Prefix)) as Tier;
}

export interface SearchHit<P> {
  product: P;
  tier: Tier;
}

/** Rank products for a query. Empty query = everything by best-sellers. */
export function searchIndex<P extends Searchable>(index: readonly IndexedProduct<P>[], query: string, opts: { minTier?: Tier; limit?: number } = {}): SearchHit<P>[] {
  const whole = query.toLowerCase().normalize("NFC").trim().replace(/\s+/g, " ");
  if (!whole) return index.map((e) => ({ product: e.product, tier: Tier.Exact })).sort((a, b) => (b.product.salesCount ?? 0) - (a.product.salesCount ?? 0));
  const wholeKey = phoneticKey(whole);
  const qWords = whole.split(" ");
  const qKeys = qWords.map(phoneticKey);
  const min = opts.minTier ?? Tier.Fuzzy;
  const hits: SearchHit<P>[] = [];
  for (const e of index) {
    let best: Tier = Tier.None;
    if (e.barcode && e.barcode === whole) best = Tier.Barcode;
    for (const t of e.names) {
      if (best >= Tier.Exact) break;
      const tier = termTier(qWords, qKeys, whole, wholeKey, t, false);
      if (tier > best) best = tier;
    }
    if (best < Tier.Alias)
      for (const t of e.aliases) {
        const tier = termTier(qWords, qKeys, whole, wholeKey, t, true);
        if (tier > best) best = tier;
        if (best === Tier.Alias) break;
      }
    if (best >= min) hits.push({ product: e.product, tier: best });
  }
  hits.sort((a, b) => b.tier - a.tier || (b.product.salesCount ?? 0) - (a.product.salesCount ?? 0));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** One-shot helper (builds the index each call – use buildIndex + searchIndex in lists). */
export const searchProducts = <P extends Searchable>(products: readonly P[], query: string, opts?: { minTier?: Tier; limit?: number }) =>
  searchIndex(buildIndex(products), query, opts).map((h) => h.product);

/**
 * Matcher for sold lines (bill item search): same rules down to alias level, no fuzzy (a bill list
 * should not fill up with near misses). Compiled once per query; results cached per item name.
 */
let lastMatcher: { q: string; fn: (item: { nameHi: string; nameEn: string }) => boolean } | null = null;
export function itemMatcher(query: string) {
  if (lastMatcher?.q === query) return lastMatcher.fn;
  const memo = new Map<string, boolean>();
  const fn = (item: { nameHi: string; nameEn: string }) => {
    const k = `${item.nameHi}\u0001${item.nameEn}`;
    let v = memo.get(k);
    if (v === undefined) {
      v = searchIndex(buildIndex([{ id: "", nameHi: item.nameHi, nameEn: item.nameEn }]), query, { minTier: Tier.Alias }).length > 0;
      memo.set(k, v);
    }
    return v;
  };
  lastMatcher = { q: query, fn };
  return fn;
}

/** Does a sold line (bill item) match a query by name or the built-in aliases? */
export const itemMatches = (item: { nameHi: string; nameEn: string }, query: string) => itemMatcher(query)(item);

/** Closest products even when nothing matched (for "did you mean"). */
export function closest<P extends Searchable>(index: readonly IndexedProduct<P>[], query: string, n = 3): P[] {
  const qk = phoneticKey(query).replace(/ /g, "");
  if (!qk) return [];
  return index
    .map((e) => ({ p: e.product, d: Math.min(...e.names.map((t) => editDistance(qk, t.key.replace(/ /g, ""), 99))) }))
    .sort((a, b) => a.d - b.d || (b.p.salesCount ?? 0) - (a.p.salesCount ?? 0))
    .slice(0, n)
    .map((x) => x.p);
}
