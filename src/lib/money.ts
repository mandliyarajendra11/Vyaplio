const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export const round2 = (n: number) => {
  const rounded = Math.round(n * 100) / 100;
  return rounded === 0 ? 0 : rounded; // Never display a fully reversed bill's floating-point residue as −₹0.
};
/** ₹1,23,456 – Indian digit grouping. */
export const formatINR = (n: number) => inr.format(round2(n));
export const formatNum = (n: number) => num.format(round2(n));

/** Rupees typed by the shopkeeper ("1,250", "९९.५"). Empty = 0. Invalid / negative = null. */
export function parseMoney(input: string): number | null {
  const text = input.trim().replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)).replace(/[,₹\s]/g, "");
  if (!text) return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const v = Number(text);
  return Number.isFinite(v) && v <= 9999999999.99 ? v : null;
}

/** Preserve Hindi keypad digits before filtering a payment field. */
export const paymentInput = (text: string) => text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)).replace(/[^\d.]/g, "");
