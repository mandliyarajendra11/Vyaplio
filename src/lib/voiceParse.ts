/**
 * Quantities in what the shopkeeper says: "do kilo chini", "दो किलो चीनी", "aadha kilo dal",
 * "ढाई सौ ग्राम जीरा", "3 packet maggi", "sava kilo", "1.5 litre tel".
 * Money ("₹20 का सामान", item 14): "20 rupaye ki chini", "₹20 का तेल", "50 ka atta" → amount, no qty.
 * Returns the number + unit that was said and the remaining words (the product to look for).
 * qtyForProduct() then decides whether that is safe to put on the bill for a given product.
 */
import type { Unit } from "./db";

export type SpokenUnit = Unit | "g" | "ml" | "dozen";

export interface SpokenQuantity {
  qty: number | null;
  unit: SpokenUnit | null;
  /** The words left for the product search. */
  rest: string;
  /** Said as money ("20 rupaye ki chini"): no quantity is taken from it. */
  money?: boolean;
  /** The ₹ amount when said as money (loose items: qty = amount / price; packs can't be sold by amount). */
  amount?: number;
}

const NUM: Record<string, number> = {};
const add = (n: number, ...words: string[]) => words.forEach((w) => (NUM[w] = n));
add(0, "zero", "shunya", "शून्य");
add(1, "ek", "one", "एक", "ik");
add(2, "do", "two", "दो", "doh");
add(3, "teen", "tin", "three", "तीन");
add(4, "char", "chaar", "four", "चार");
add(5, "paanch", "panch", "paach", "five", "पांच", "पाँच", "पाच");
add(6, "chhah", "chhe", "chah", "che", "chhai", "six", "छह", "छः", "छे", "छै");
add(7, "saat", "sat", "seven", "सात");
add(8, "aath", "ath", "eight", "आठ");
add(9, "nau", "nine", "नौ");
add(10, "das", "dus", "ten", "दस");
add(11, "gyarah", "gyara", "eleven", "ग्यारह");
add(12, "barah", "bara", "baarah", "twelve", "बारह");
add(13, "terah", "thirteen", "तेरह");
add(14, "chaudah", "fourteen", "चौदह");
add(15, "pandrah", "pandrah", "fifteen", "पंद्रह", "पन्द्रह");
add(16, "solah", "sixteen", "सोलह");
add(17, "satrah", "seventeen", "सत्रह");
add(18, "atharah", "eighteen", "अठारह");
add(19, "unnis", "unees", "nineteen", "उन्नीस");
add(20, "bees", "bis", "twenty", "बीस");
add(25, "pachees", "pachchis", "twenty-five", "पच्चीस");
add(30, "tees", "thirty", "तीस");
add(40, "chalis", "chaalis", "forty", "चालीस");
add(50, "pachas", "pachaas", "fifty", "पचास");
add(100, "sau", "hundred", "सौ");

const FRACTION: Record<string, number> = {};
const frac = (n: number, ...words: string[]) => words.forEach((w) => (FRACTION[w] = n));
frac(0.5, "aadha", "adha", "aadhi", "adhi", "aadhe", "half", "आधा", "आधी", "आधे");
frac(0.25, "paav", "paao", "pao", "quarter", "पाव", "पौआ");
frac(0.75, "paun", "paune", "पौन");
frac(1.5, "dedh", "derh", "dedha", "डेढ़", "डेढ");
frac(2.5, "dhai", "dhaai", "adhai", "ढाई", "अढ़ाई");

// "sava do" = 2.25, "saade teen" = 3.5, "paune do" = 1.75 (prefix + number)
const PREFIX: Record<string, number> = { sava: 0.25, sawa: 0.25, "सवा": 0.25, saade: 0.5, sade: 0.5, saadhe: 0.5, sadhe: 0.5, "साढ़े": 0.5, "साढे": 0.5, paune: -0.25, "पौने": -0.25 };

const UNIT: Record<string, SpokenUnit> = {};
const unit = (u: SpokenUnit, ...words: string[]) => words.forEach((w) => (UNIT[w] = u));
unit("kg", "kilo", "kilos", "kg", "kgs", "kilogram", "kilograms", "keji", "किलो", "केजी", "किलोग्राम", "किग्रा");
unit("g", "gram", "grams", "gm", "gms", "g", "gr", "ग्राम");
unit("ltr", "litre", "liter", "litres", "liters", "ltr", "l", "lit", "लीटर", "लिटर");
unit("ml", "ml", "millilitre", "milliliter", "मिली", "एमएल");
unit("pkt", "packet", "packets", "pkt", "pkts", "pack", "packs", "paket", "pakit", "पैकेट", "पैकिट", "पैक", "पाकिट");
unit("pcs", "piece", "pieces", "pcs", "pc", "pis", "nag", "पीस", "नग");
unit("box", "box", "boxes", "dabba", "dibba", "डब्बा", "डिब्बा", "बॉक्स");
unit("dozen", "dozen", "darjan", "दर्जन");

const MONEY = new Set(["rupaye", "rupay", "rupee", "rupees", "rs", "rupiya", "rupaiye", "rupaiya", "rupye", "rupe", "inr", "रुपये", "रुपए", "रूपये", "रुपया", "रुपैया", "रुपय", "रु", "₹"]);
// "50 ka atta": a plain number joined straight to the item (no unit) is money.
const OF = new Set(["ka", "ki", "ke", "का", "की", "के"]);
// Joining / polite words that are not part of the product: "do kilo ki chini de do".
const FILLER = new Set(["ka", "ki", "ke", "का", "की", "के", "wala", "wali", "वाला", "वाली", "and", "aur", "और", "please", "plz", "chahiye", "चाहिए", "dena", "देना", "दीजिए", "dijiye", "of", "a", "an"]);
const GIVE = /\b(de\s*do|dedo|de\s*dijiye|दे\s*दो|दे\s*दीजिए|दे\s*दें)\b|(दे\s*दो|दे\s*दीजिए|दे\s*दें)/gu;

const clean = (t: string) => t.toLowerCase().replace(/\u093C/g, "").replace(/\u0901/g, "\u0902");
const toLatinDigits = (v: string) => v.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
// Normalise keys once (nukta-less, anusvara) so "डेढ़" written with or without nukta both hit.
for (const tbl of [NUM, FRACTION, PREFIX, UNIT] as Record<string, unknown>[])
  for (const k of Object.keys(tbl)) if (clean(k) !== k) tbl[clean(k)] = tbl[k];

function numberAt(tokens: string[], i: number): { value: number; used: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;
  if (/^\d+([.,]\d+)?$/.test(t)) return { value: Number(t.replace(",", ".")), used: 1 };
  const m = /^(\d+)\/(\d+)$/.exec(t);
  if (m && Number(m[2]) > 0) return { value: Number(m[1]) / Number(m[2]), used: 1 };
  if (t in PREFIX) {
    const next = numberAt(tokens, i + 1);
    if (next && Number.isInteger(next.value)) return { value: next.value + PREFIX[t], used: 1 + next.used };
    if (PREFIX[t] > 0 && UNIT[tokens[i + 1]]) return { value: 1 + PREFIX[t], used: 1 }; // "sava kilo" = 1.25
    return null;
  }
  if (t in FRACTION) return { value: FRACTION[t], used: 1 };
  if (t in NUM) {
    let value = NUM[t];
    let used = 1;
    // "dhai sau gram", "do sau", "teen sau pachas"
    if (tokens[i + 1] === "sau" || tokens[i + 1] === "सौ" || tokens[i + 1] === "hundred") {
      value *= 100;
      used++;
      const tail = tokens[i + used];
      if (tail && tail in NUM && NUM[tail] < 100) {
        value += NUM[tail];
        used++;
      }
    }
    return { value, used };
  }
  return null;
}

export function parseSpokenQuantity(text: string): SpokenQuantity {
  const norm = toLatinDigits(text.normalize("NFC"))
    .replace(GIVE, " ")
    .replace(/₹/g, " ₹ ") // "₹20", "20₹"
    .replace(/\b(rs|inr)\.?(?=\s*\d)/giu, " $1 ") // "rs.20", "Rs 20"
    .replace(/(^|\s)रु\.?(?=\s*\d)/gu, "$1 रु ")
    .replace(/[।,!?]+/g, " ")
    .replace(/(\d)([a-z\u0900-\u097F]+)/giu, "$1 $2") // "2kg", "500g"
    .trim();
  const tokens = norm.split(/\s+/).filter(Boolean).map(clean);
  // "ढाई सौ ग्राम": a fraction before sau multiplies it.
  let qty: number | null = null;
  let unit: SpokenUnit | null = null;
  let money = false;
  let amount: number | undefined;
  let start = -1;
  let end = -1;
  for (let i = 0; i < tokens.length && qty === null; i++) {
    let n = numberAt(tokens, i);
    if (!n) continue;
    let used = n.used;
    if (FRACTION[tokens[i]] !== undefined && (tokens[i + 1] === "sau" || tokens[i + 1] === "सौ")) {
      n = { value: FRACTION[tokens[i]] * 100, used: 2 };
      used = 2;
    }
    const u = UNIT[tokens[i + used]];
    const before = MONEY.has(tokens[i - 1] ?? "");
    const after = MONEY.has(tokens[i + used]);
    // "50 ka atta" (a number of 5 or more, then ka / ki / ke, no unit) = ₹50 worth.
    const ofMoney = !u && !before && !after && OF.has(tokens[i + used]) && n.value >= 5 && i + used < tokens.length - 1;
    const isMoney = before || after || ofMoney;
    const isDo = tokens[i] === "do" || tokens[i] === "दो";
    // A bare number word only counts at the start ("do maggi") or before a unit; "maggi do" = "give".
    if (!u && !isMoney && i > 0 && isDo) continue;
    if (!u && !isMoney && i > 0 && tokens.length > 1 && i !== tokens.length - 1) continue;
    if (!u && FRACTION[tokens[i]] === 0.25 && i > 0) continue; // "pav" alone is bread, not a quarter
    if (isMoney) {
      money = true;
      amount = Math.round(n.value * 100) / 100;
      start = before ? i - 1 : i;
      end = after ? i + used + 1 : i + used;
      break;
    }
    qty = n.value;
    unit = u ?? null;
    start = i;
    end = i + used + (u ? 1 : 0);
  }
  const left = tokens.filter((t, j) => (j < start || j >= end) && !FILLER.has(t) && !MONEY.has(t));
  // A trailing "do" / "दो" that was not the quantity is "give": "maggi do".
  while (left.length > 1 && ["do", "दो", "de", "दे"].includes(left[left.length - 1])) left.pop();
  return { qty: money ? null : qty, unit: money ? null : unit, rest: left.join(" "), ...(money ? { money, amount } : {}) };
}

/**
 * The quantity to put on the bill for a product sold in `productUnit`, or null when it is not safe
 * to guess (said "2 kg" for a packet item, half a piece, more than 1000, …).
 */
export function qtyForProduct(said: Pick<SpokenQuantity, "qty" | "unit">, productUnit: Unit): number | null {
  if (said.qty === null || !(said.qty > 0)) return null;
  let q = said.qty;
  const u = said.unit;
  const weight = productUnit === "kg" || productUnit === "ltr";
  if (u === null) {
    // No unit said: take the number in the product's own unit.
  } else if (productUnit === "kg") {
    if (u === "g") q = q / 1000;
    else if (u !== "kg") return null;
  } else if (productUnit === "ltr") {
    if (u === "ml") q = q / 1000;
    else if (u !== "ltr") return null;
  } else if (u === "dozen") {
    q = q * 12;
  } else if (u === "box" ? productUnit !== "box" : !(u === "pcs" || u === "pkt") || productUnit === "box") {
    return null;
  }
  q = Math.round(q * 1000) / 1000;
  if (!weight && !Number.isInteger(q)) return null;
  if (q <= 0 || q > 1000) return null;
  return q;
}
