import { round2 } from "./money";
import { grossLineTotal, lineTotal } from "./units";

export type BillDiscount = { kind: "amount" | "percent"; value: number };
export class DiscountError extends Error {
  constructor() { super("Invalid bill discount"); }
}

export function discountAmount(subtotal: number, discount?: BillDiscount | null): number {
  if (!discount) return 0;
  const { kind, value } = discount;
  if (!Number.isFinite(subtotal) || subtotal < 0 || !Number.isFinite(value) || value < 0
    || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6
    || (kind !== "amount" && kind !== "percent")
    || value > (kind === "percent" ? 100 : subtotal)) throw new DiscountError();
  return kind === "percent" ? round2(subtotal * value / 100) : round2(value);
}

/** Allocate paise proportionally, with stable largest-remainder tie breaking. No negative lines. */
export function allocateDiscount<T extends { qty: number; price: number; amount?: number; discount?: number }>(items: T[], discount?: BillDiscount): (T & { discount?: number })[] {
  // Item discounts are already included. Allocate the bill discount only over what remains.
  const gross = items.map((it) => {
    discountAmount(grossLineTotal(it), { kind: "amount", value: it.discount ?? 0 });
    return Math.round(lineTotal(it) * 100);
  });
  const subtotal = gross.reduce((a, v) => a + v, 0);
  const cents = Math.round(discountAmount(subtotal / 100, discount) * 100);
  if (!cents) return items.map((it) => ({ ...it }));
  const shares = gross.map((value, index) => {
    const exact = cents * value / subtotal;
    return { index, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const left = cents - shares.reduce((a, s) => a + s.cents, 0);
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < left; i++) ranked[i].cents++;
  return items.map((it, i) => ({ ...it, discount: round2((it.discount ?? 0) + shares[i].cents / 100) }));
}

export const totalDiscount = (items: { discount?: number }[]) => round2(items.reduce((a, it) => a + (it.discount ?? 0), 0));
export const itemDiscountTotal = (items: { itemDiscount?: number }[]) => round2(items.reduce((a, it) => a + (it.itemDiscount ?? 0), 0));
export const billDiscountTotal = (items: { discount?: number; itemDiscount?: number }[]) => round2(totalDiscount(items) - itemDiscountTotal(items));

/** Optional cash-counter round-off, always to the nearest whole rupee. */
export const roundOffAmount = (payable: number) => round2(Math.round(payable) - payable);
export const roundOffTotal = (items: { rounding?: number }[]) => round2(items.reduce((a, it) => a + (it.rounding ?? 0), 0));

/** Keep the sum of sale lines equal to the payable amount so every later return reverses exactly. */
export function roundSaleItems<T extends { qty: number; price: number; amount?: number; discount?: number; rounding?: number }>(items: T[]): T[] {
  const out = items.map((it) => ({ ...it }));
  const payable = round2(out.reduce((a, it) => a + lineTotal(it), 0));
  const delta = Math.round(roundOffAmount(payable) * 100);
  if (!delta || !out.length) return out;
  const magnitude = Math.abs(delta);
  const shares = out.map((it, index) => {
    const exact = magnitude * lineTotal(it) / payable;
    return { index, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const left = magnitude - shares.reduce((a, s) => a + s.cents, 0);
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < left; i++) ranked[i].cents++;
  const sign = Math.sign(delta);
  for (const share of shares) {
    if (!share.cents) continue;
    out[share.index].rounding = round2((out[share.index].rounding ?? 0) + sign * share.cents / 100);
    if (lineTotal(out[share.index]) < 0) throw new Error("Rounding exceeds line value");
  }
  return out;
}
