import type { Product, Unit } from "./db";
import { validAmount, validQtyFor } from "./units";

export type ImportRow = { line: number; name: string; unit: Unit; sell: string; buy: string; qty: string; barcode: string };
export type ImportIssue = { line: number; message: string };
export const IMPORT_LIMIT = 500;
export const IMPORT_BYTES = 2_000_000;
export const IMPORT_HEADERS = ["name", "unit", "sell_price", "buy_price", "qty", "barcode"];

// RFC-style quoted cells, including commas and newlines. Fail closed on malformed quotes.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell); cell = ""; closed = false;
      if (c === ",") continue;
      if (c === "\r" && source[i + 1] === "\n") i++;
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else if (c === '"' || closed) throw new Error("csvFormat");
    else cell += c;
  }
  if (quoted) throw new Error("csvFormat");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const aliases: Record<string, string> = {
  name: "name", name_hi: "name", "नाम": "name", unit: "unit", "इकाई": "unit",
  sell_price: "sell", price: "sell", "बेचने का दाम": "sell", buy_price: "buy", "खरीद का दाम": "buy",
  qty: "qty", stock: "qty", "मात्रा": "qty", barcode: "barcode", "बारकोड": "barcode",
};
const clean = (s: string) => s.trim().replace(/\s+/g, " ");
export const importNameKey = (s: string) => clean(s).toLocaleLowerCase();
export const parseDecimal = (s: string) => {
  const normalized = s.trim().replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
  return /^\d+(?:\.\d{1,2})?$/.test(normalized) ? Number(normalized) : NaN;
};

export function readImport(text: string): ImportRow[] {
  const records = parseCSV(text);
  if (records.length < 2) throw new Error("csvEmpty");
  const columns = records[0].map((v) => aliases[clean(v).toLocaleLowerCase()] ?? "");
  if (!columns.includes("name") || !columns.includes("sell")) throw new Error("csvHeaders");
  if (columns.some((v) => !v)) throw new Error("csvExtra");
  if (records.length - 1 > IMPORT_LIMIT) throw new Error("csvTooMany");
  if (columns.some((v, i) => v && columns.indexOf(v) !== i)) throw new Error("csvHeaders");
  return records.slice(1).map((cells, i) => {
    if (cells.length > columns.length) throw new Error("csvFormat");
    const get = (key: string) => clean(cells[columns.indexOf(key)] ?? "");
    const name = get("name");
    return { line: i + 2, name, unit: (get("unit").toLowerCase() || "pcs") as Unit, sell: get("sell"), buy: get("buy"), qty: get("qty"), barcode: get("barcode") };
  });
}

const units: Unit[] = ["pcs", "pkt", "box", "kg", "ltr"];
export function validateImport(rows: ImportRow[], existing: Product[], msg: (key: string) => string): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const names = new Set(existing.flatMap((p) => [p.nameHi, p.nameEn].filter(Boolean).map(importNameKey)));
  const barcodes = new Set(existing.map((p) => p.barcode).filter(Boolean));
  for (const row of rows) {
    const issue = (key: string) => issues.push({ line: row.line, message: msg(key) });
    const name = importNameKey(row.name);
    if (!name || row.name.length > 80) issue("badName");
    else if (names.has(name)) issue("duplicateName");
    names.add(name);
    if (!units.includes(row.unit)) issue("badUnit");
    const sell = parseDecimal(row.sell);
    const buy = row.buy ? parseDecimal(row.buy) : 0;
    const qty = row.qty ? parseDecimal(row.qty) : 0;
    if (!validAmount(sell)) issue("badSell");
    if (!Number.isFinite(buy) || buy < 0 || buy > 100000) issue("badBuy");
    if (units.includes(row.unit) && !validQtyFor(qty, row.unit, true)) issue("badQty");
    if (row.barcode) {
      if (row.barcode.length > 80) issue("badBarcode");
      else if (barcodes.has(row.barcode)) issue("duplicateBarcode");
      barcodes.add(row.barcode);
    }
  }
  return issues;
}
