/**
 * Sealed packs vs loose goods (item 14).
 *  - packed: sold by piece / packet / box, whole numbers only, optional MRP + barcode, expiry per batch.
 *  - loose: sold by weight / volume. Stock and price are in a base unit (kg or litre, price per kg / L);
 *    quantities are entered in g / kg or ml / L and kept to 10 g / 10 ml (0.01 of the base unit – the
 *    same two decimals stock, bills and the cloud already use). No MRP.
 * A product's kind always matches its unit (saveProduct enforces it), so older rows without `kind`
 * are read by unit: kg / ltr → loose, pcs / pkt / box → packed.
 */
import type { Product, Unit } from "./db";
import { round2 } from "./money";

export const PRODUCT_KINDS = ["packed", "loose"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];
export const LOOSE_UNITS: Unit[] = ["kg", "ltr"];
export const PACKED_UNITS: Unit[] = ["pcs", "pkt", "box"];

export const isLoose = (unit: Unit) => unit === "kg" || unit === "ltr";
export const kindForUnit = (unit: Unit): ProductKind => (isLoose(unit) ? "loose" : "packed");
export const kindOf = (p: Pick<Product, "unit"> & { kind?: ProductKind }): ProductKind => p.kind ?? kindForUnit(p.unit);
export const unitsFor = (kind: ProductKind) => (kind === "loose" ? LOOSE_UNITS : PACKED_UNITS);

/** Smallest loose quantity: 10 g / 10 ml. */
export const LOOSE_PRECISION = 0.01;
/** Weight / volume presets on the picker and for the per-product step (100 g, 250 g, 500 g, 1 kg). */
export const LOOSE_PRESETS = [0.1, 0.25, 0.5, 1] as const;
/** Quick money buttons for "₹20 का सामान". */
export const AMOUNT_PRESETS = [10, 20, 50, 100] as const;
/** Default "+" step when none was chosen: one whole unit (1 kg / 1 L / 1 piece). */
export const DEFAULT_STEP = 1;

/** The product's own step for + / − and the stock screen (packed: always 1). */
export const stepOf = (p: Pick<Product, "unit"> & { step?: number; kind?: ProductKind }) =>
  kindOf(p) === "packed" ? 1 : p.step && validStep(p.step) ? p.step : DEFAULT_STEP;

export const validStep = (s: number) => Number.isFinite(s) && s >= LOOSE_PRECISION && s <= 100 && isMultiple(s, LOOSE_PRECISION);

const isMultiple = (q: number, of: number) => Math.abs(q / of - Math.round(q / of)) < 1e-6;

/** A quantity that fits the product's kind: whole numbers for packs, 10 g / 10 ml steps for loose. */
export function validQtyFor(q: number, unit: Unit, allowZero = false) {
  if (!Number.isFinite(q) || (allowZero ? q < 0 : q <= 0) || q > 100000) return false;
  return isLoose(unit) ? isMultiple(q, LOOSE_PRECISION) : Number.isInteger(q);
}

/**
 * "₹20 का सामान": the amount is the anchor, the quantity is derived from the price per kg / L and
 * rounded to the nearest 10 g / 10 ml. The bill line keeps both and its total is exactly the amount.
 * null = not possible (packed item, no price, or less than 10 g worth).
 */
export function qtyForAmount(amount: number, p: Pick<Product, "unit" | "sellPrice"> & { kind?: ProductKind }): number | null {
  if (kindOf(p) !== "loose" || !(amount > 0) || !Number.isFinite(amount) || !(p.sellPrice > 0)) return null;
  const q = round2(Math.round(amount / p.sellPrice / LOOSE_PRECISION) * LOOSE_PRECISION);
  return q >= LOOSE_PRECISION ? q : null;
}

/** A valid money amount for a bill line (paise allowed, at most ₹1,00,000). */
export const validAmount = (a: number) => Number.isFinite(a) && a > 0 && a <= 100000 && Math.abs(a * 100 - Math.round(a * 100)) < 1e-6;

/** Line value: the entered amount when sold by amount, otherwise qty × price. */
export const grossLineTotal = (l: { qty: number; price: number; amount?: number }) => (l.amount !== undefined ? round2(l.amount) : round2(l.qty * l.price));
export const lineTotal = (l: { qty: number; price: number; amount?: number; discount?: number; rounding?: number }) => round2(grossLineTotal(l) - (l.discount ?? 0) + (l.rounding ?? 0));

/**
 * Value of part of a line (returns). Amount lines are valued pro rata of what was paid, cumulatively:
 * value of (already + q) minus value of (already), so several part returns add up to exactly the amount.
 */
export function partValue(l: { qty: number; price: number; amount?: number; discount?: number; rounding?: number }, q: number, already = 0) {
  if (l.amount === undefined && l.discount === undefined && l.rounding === undefined) return round2(q * l.price);
  const value = lineTotal(l);
  const upTo = (x: number) => (x >= l.qty - 1e-9 ? value : round2((value * x) / l.qty));
  return round2(upTo(already + q) - upTo(already));
}

type T = (key: string, values?: Record<string, string | number>) => string;

/** "445 ग्राम" / "1.25 किलो" / "750 मिली" / "3 पैकेट". */
export function fmtQty(t: T, qty: number, unit: Unit) {
  const n = (x: number) => String(Math.round(x * 100) / 100);
  if (isLoose(unit) && Math.abs(qty) < 1 && qty !== 0) return t(unit === "kg" ? "units.g" : "units.ml", { n: Math.round(qty * 1000) });
  return `${n(qty)} ${t(`unit.${unit}`)}`;
}

/** Keypad text in g / kg (or ml / L) → base-unit quantity; null when not a valid 10 g step. */
export function parseLooseInput(text: string, small: boolean): number | null {
  const v = Number(text.trim().replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)).replace(",", "."));
  if (!text.trim() || !Number.isFinite(v) || v <= 0) return null;
  const q = small ? v / 1000 : v;
  if (!isMultiple(q, LOOSE_PRECISION) || q > 100000) return null;
  return round2(q);
}

/* ------------------------------ CSV ------------------------------ */

/** Stock CSV: kind and the pack / loose details sit after the original columns. */
export const PRODUCTS_CSV_HEADERS = ["name_hi", "name_en", "unit", "qty", "buy_price", "sell_price", "low_stock_at", "expiry_date", "barcode", "supplier", "kind", "step", "mrp", "opens_into", "pack_size"];
export function productsCSVRows(rows: Product[]) {
  const byId = new Map(rows.map((p) => [p.id, p]));
  return rows.map((p) => {
    const loose = p.looseId ? byId.get(p.looseId) : undefined;
    return [
      p.nameHi, p.nameEn, p.unit, p.qty, p.buyPrice, p.sellPrice, p.lowStockAt, p.expiryDate, p.barcode, p.supplier,
      kindOf(p),
      kindOf(p) === "loose" ? stepOf(p) : "",
      p.mrp ?? "",
      loose ? loose.nameEn || loose.nameHi : "",
      p.packSize ?? "",
    ];
  });
}

/** "Sugar x0.44 kg (Rs 20)" for amount lines, "Maggi x2" otherwise (bill / correction CSVs). */
export const csvItem = (l: { nameEn: string; nameHi?: string; qty: number; unit: Unit; amount?: number }) =>
  `${l.nameEn || l.nameHi || ""} x${l.qty}${l.amount !== undefined ? ` ${l.unit} (Rs ${l.amount})` : ""}`;
