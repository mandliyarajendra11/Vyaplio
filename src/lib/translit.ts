/**
 * Offline Hindi <-> Roman phonetic key for search ("chini", "cheeni", "चीनी" -> the same key).
 *
 * Devanagari is first romanised (simple ITRANS-like table: inherent vowel, matras, virama, nukta,
 * anusvara / chandrabindu), then both scripts go through the same folding:
 *  - aspirates lose their h (kh->k, chh/ch->c, th->t, dh->d, bh->b, jh->j, gh->g, ph->f), sh/s->s
 *  - vowel length is ignored (aa->a, ee/ii->i, oo/uu->u), ai/ay->e, au/ou->o
 *  - nukta sounds fold to the plain ones (z->j, q->k, f stays f, ड़->d), w->v
 *  - nasals before a consonant (anusvara, n, m) -> n; doubled letters collapse
 *  - the short "a" is dropped except at the start of a word (schwa: चावल = chaval = chawal = "cvl")
 * The key is lossy on purpose: it is only used to compare words, never shown.
 */

const CONS: Record<string, string> = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "n", च: "ch", छ: "chh", ज: "j", झ: "jh", ञ: "n",
  ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n", त: "t", थ: "th", द: "d", ध: "dh", न: "n",
  प: "p", फ: "ph", ब: "b", भ: "bh", म: "m", य: "y", र: "r", ल: "l", ळ: "l", व: "v",
  श: "sh", ष: "sh", स: "s", ह: "h",
  // precomposed nukta letters
  क़: "q", ख़: "kh", ग़: "g", ज़: "z", ड़: "d", ढ़: "dh", फ़: "f", य़: "y",
};
const NUKTA: Record<string, string> = { क: "q", ख: "kh", ग: "g", ज: "z", ड: "d", ढ: "dh", फ: "f", य: "y" };
const VOWELS: Record<string, string> = { अ: "a", आ: "aa", इ: "i", ई: "ii", उ: "u", ऊ: "uu", ऋ: "ri", ए: "e", ऐ: "ai", ओ: "o", औ: "au", ऑ: "o", ऍ: "e" };
const MATRAS: Record<string, string> = { "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e" };
const VIRAMA = "्";
const NUKTA_SIGN = "़";
const NASAL = new Set(["ं", "ँ"]);
const DIGITS_RE = /[०-९]/g;
export const DEVANAGARI_RE = /[\u0900-\u097F]/;

/** Devanagari -> plain Roman letters (other characters pass through). */
export function romanize(text: string): string {
  const s = text.normalize("NFC");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let next = s[i + 1];
    let cons = CONS[ch];
    if (cons !== undefined) {
      if (next === NUKTA_SIGN) {
        cons = NUKTA[ch] ?? cons;
        i++;
        next = s[i + 1];
      }
      out += cons;
      if (next === VIRAMA) i++;
      else if (next && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        i++;
      } else out += "a"; // inherent vowel (dropped later by the folding, except word-initially)
      continue;
    }
    if (VOWELS[ch] !== undefined) out += VOWELS[ch];
    else if (MATRAS[ch] !== undefined) out += MATRAS[ch];
    else if (NASAL.has(ch)) out += "n";
    else if (ch === "ः") out += "h";
    else if (ch === NUKTA_SIGN || ch === VIRAMA) continue;
    else if (ch === "।" || ch === "॥") out += " ";
    else out += ch;
  }
  return out.replace(DIGITS_RE, (d) => String(d.charCodeAt(0) - 0x0966));
}

function foldWord(w: string): string {
  if (!w) return "";
  if (/^\d+(\.\d+)?$/.test(w)) return w;
  let s = w;
  s = s.replace(/tch/g, "ch").replace(/c(?!h)/g, "k"); // English spellings: matchis, biscuit
  s = s.replace(/chh|ch/g, "c").replace(/sh/g, "s").replace(/kh/g, "k").replace(/gh/g, "g").replace(/jh/g, "j");
  s = s.replace(/th/g, "t").replace(/dh/g, "d").replace(/bh/g, "b").replace(/ph/g, "f");
  s = s.replace(/ck/g, "k").replace(/q/g, "k").replace(/x/g, "ks").replace(/z/g, "j").replace(/w/g, "v");
  s = s.replace(/ee|ii|ie/g, "i").replace(/oo|uu/g, "u").replace(/aa+/g, "a");
  s = s.replace(/ai|ae|ay|ei/g, "e").replace(/au|ou|ao/g, "o");
  s = s.replace(/y$/, "i");
  s = s.replace(/m(?=[bp])/g, "n");
  s = s.replace(/(.)\1+/g, "$1");
  s = s.replace(/h$/, (m, off) => (off > 1 ? "" : m)); // trailing h after a vowel (namah ~ nama)
  // schwa: drop short a except word-initially
  s = s[0] + s.slice(1).replace(/a/g, "");
  return s.replace(/(.)\1+/g, "$1");
}

/** Phonetic key of a whole string: words folded and joined by single spaces. */
export function phoneticKey(text: string): string {
  const r = romanize(text.toLowerCase())
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.\s]/g, " ");
  return r
    .split(/\s+/)
    .map((w) => foldWord(w.replace(/^\.+|\.+$/g, "")))
    .filter(Boolean)
    .join(" ");
}

/** Phonetic keys of each word. */
export const phoneticWords = (text: string) => phoneticKey(text).split(" ").filter(Boolean);

/** Levenshtein distance with an early exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
