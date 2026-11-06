import type { Unit } from "./db";

export const isLooseUnit = (unit: Unit) => unit === "kg" || unit === "ltr";

/** Stock is stored to two decimals in kg/litres; never silently round input. */
export function parseQuantity(input: string, unit: Unit): number | null {
  const text = input.trim().replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966));
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 9999999999.99) return null;
  if (!isLooseUnit(unit) && !Number.isInteger(value)) return null;
  return value;
}
