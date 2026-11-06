/**
 * Older bills and search (/sales): date range presets, filters, search and the indexed query.
 *
 * Days are the device's local calendar days (`sale.day`, yyyy-MM-dd), the same key the bills,
 * corrections and the cash drawer already use – in India that is IST. Range queries go through the
 * [shopId+day] index; a customer's bills through the customerId index (Dexie v7). Everything else
 * (method / status / text search) is filtered in memory on that already narrowed set.
 */
import { addDays, format, parseISO, startOfMonth, startOfWeek } from "date-fns";
import type { Customer, LedgerEntry, Sale, SaleCorrection } from "./db";
import { billNo } from "./billno";
import { db } from "./db";
import { dayKey, fmtDate } from "./dates";
import { round2 } from "./money";
import { netTotal, saleStatus } from "./ops";
import { partSum, paymentsOf, pendingUpi, salePaymentCSV } from "./payments";
import { itemMatcher } from "./search";
import { computeDayStats, type DayStats } from "./stats";
import { csvItem } from "./units";

export const PRESETS = ["today", "yesterday", "week", "month", "all"] as const;
export type Preset = (typeof PRESETS)[number] | "custom";
export const BILL_METHODS = ["cash", "upi", "credit", "split", "upiPending"] as const;
export type BillMethod = (typeof BILL_METHODS)[number];
export const BILL_STATUSES = ["active", "returned", "cancelled", "late"] as const;
export type BillStatusFilter = (typeof BILL_STATUSES)[number];

export interface BillFilter {
  preset: Preset;
  from: string; // yyyy-MM-dd, inclusive
  to: string; // yyyy-MM-dd, inclusive
  methods: BillMethod[]; // any of (empty = all)
  statuses: BillStatusFilter[]; // any of (empty = all)
  q: string;
  customerId?: string;
}

/** Earliest day "all" reaches back to (bills cannot be older than the app). */
export const ALL_FROM = "2000-01-01";
export const PAGE_SIZE = 40;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const fmtDay = (d: Date) => format(d, "yyyy-MM-dd");
const isDay = (v: string | null | undefined): v is string => !!v && DAY_RE.test(v) && !Number.isNaN(parseISO(v).getTime()) && fmtDay(parseISO(v)) === v;

/** Inclusive day range of a preset, in the device's local calendar. Weeks start on Monday. */
export function presetRange(preset: Exclude<Preset, "custom">, now: number): { from: string; to: string } {
  const today = dayKey(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = fmtDay(addDays(parseISO(today), -1));
      return { from: y, to: y };
    }
    case "week":
      return { from: fmtDay(startOfWeek(parseISO(today), { weekStartsOn: 1 })), to: today };
    case "month":
      return { from: fmtDay(startOfMonth(parseISO(today))), to: today };
    case "all":
      return { from: ALL_FROM, to: today };
  }
}

export const defaultFilter = (now: number): BillFilter => ({ preset: "today", ...presetRange("today", now), methods: [], statuses: [], q: "" });

/** Which preset (if any) a range is, today. */
export function presetOf(from: string, to: string, now: number): Preset {
  for (const p of PRESETS) {
    const r = presetRange(p, now);
    if (r.from === from && r.to === to) return p;
  }
  return "custom";
}

/** First ms of `from` .. last ms of `to` (local time). */
export function rangeMs(from: string, to: string) {
  return { start: parseISO(from).getTime(), end: addDays(parseISO(to), 1).getTime() - 1 };
}

export const isFiltered = (f: BillFilter) => f.methods.length > 0 || f.statuses.length > 0 || f.q.trim() !== "" || !!f.customerId;

/* ------------------------------ URL / session ------------------------------ */

export const SESSION_KEY = "dm-bills-filter";

/**
 * Query string for a filter. A preset is stored by name (so "yesterday" stays yesterday tomorrow);
 * a custom range by its dates. Defaults are omitted, so plain /sales = today, no filters.
 */
export function filterToParams(f: BillFilter): string {
  const p = new URLSearchParams();
  if (f.preset === "custom") {
    p.set("from", f.from);
    p.set("to", f.to);
  } else if (f.preset !== "today") p.set("range", f.preset);
  if (f.methods.length) p.set("pay", f.methods.join(","));
  if (f.statuses.length) p.set("status", f.statuses.join(","));
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.customerId) p.set("customer", f.customerId);
  return p.toString();
}

/** Parse a query string (or the saved session copy). Unknown values are dropped; null = nothing usable. */
export function filterFromParams(search: string, now: number): BillFilter | null {
  const p = new URLSearchParams(search);
  const keys = ["range", "from", "to", "pay", "status", "q", "customer"];
  if (!keys.some((k) => p.has(k))) return null;
  const f = defaultFilter(now);
  const range = p.get("range");
  let from = p.get("from");
  let to = p.get("to");
  if (range && (PRESETS as readonly string[]).includes(range)) Object.assign(f, { preset: range }, presetRange(range as Exclude<Preset, "custom">, now));
  else if (isDay(from) || isDay(to)) {
    from = isDay(from) ? from : (to as string);
    to = isDay(to) ? to : from;
    if (from > to) [from, to] = [to, from];
    const today = dayKey(now);
    if (to > today) to = today;
    if (from > today) from = today;
    f.from = from;
    f.to = to;
    f.preset = presetOf(from, to, now);
  }
  const list = <T extends string>(v: string | null, allowed: readonly T[]) =>
    [...new Set((v ?? "").split(",").filter((x): x is T => (allowed as readonly string[]).includes(x)))];
  f.methods = list(p.get("pay"), BILL_METHODS);
  f.statuses = list(p.get("status"), BILL_STATUSES);
  f.q = (p.get("q") ?? "").slice(0, 80);
  const c = p.get("customer");
  if (c && /^[\w-]{1,64}$/.test(c)) f.customerId = c;
  return f;
}

/* ------------------------------ matching ------------------------------ */

export { billNo };

const toLatinDigits = (v: string) => v.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));

export interface ParsedQuery {
  text: string; // lower-cased words for names / items
  digits: string; // digits only (phone / amount / bill no)
  amount: number | null; // when the query is a number (₹ and commas allowed)
  bill: string | null; // bill-number candidate (#ABC123 or 4+ hex chars)
}

export function parseQuery(raw: string): ParsedQuery {
  const q = toLatinDigits(raw.normalize("NFC").trim());
  const text = q.toLowerCase();
  const digits = q.replace(/\D/g, "");
  const num = q.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  const amount = /^\d+(\.\d{1,2})?$/.test(num) ? Number(num) : null;
  const b = q.replace(/^#/, "").replace(/\s/g, "");
  const bill = /^[0-9a-f]{4,}$/i.test(b) || q.startsWith("#") ? b.toUpperCase() : null;
  return { text, digits, amount, bill };
}

/** Methods a bill counts under for the payment filter (a split bill also counts under each of its parts). */
export function billMethods(s: Sale): Set<BillMethod> {
  const parts = paymentsOf(s);
  const out = new Set<BillMethod>();
  if (partSum(parts, "cash") > 0) out.add("cash");
  if (partSum(parts, "upi", "paid") > 0) out.add("upi");
  if (partSum(parts, "credit") > 0) out.add("credit");
  if (new Set(parts.filter((p) => p.amount > 0).map((p) => p.method)).size > 1) out.add("split");
  if (saleStatus(s) !== "cancelled" && pendingUpi(s) > 0) out.add("upiPending");
  return out;
}

export interface MatchContext {
  customers: Map<string, Customer>;
  /** Bill ids entered after their day's cash drawer was closed. */
  lateIds: Set<string>;
}

export function matchesQuery(s: Sale, q: ParsedQuery, ctx: MatchContext) {
  if (!q.text) return true;
  const c = s.customerId ? ctx.customers.get(s.customerId) : undefined;
  if (c && c.name.toLowerCase().includes(q.text)) return true;
  if (c?.phone && q.digits.length >= 3 && c.phone.replace(/\D/g, "").includes(q.digits)) return true;
  if (q.bill && billNo(s).startsWith(q.bill.slice(0, 6))) return true;
  if (q.amount !== null && (Math.abs(s.total - q.amount) < 0.005 || Math.abs(netTotal(s) - q.amount) < 0.005)) return true;
  // Items: Hindi / Roman / English and the built-in aliases ("chini" finds चीनी, "oil" finds सरसों तेल).
  const item = itemMatcher(q.text);
  return s.items.some((i) => i.nameHi.toLowerCase().includes(q.text) || i.nameEn.toLowerCase().includes(q.text) || item(i));
}

export function matchesBill(s: Sale, f: BillFilter, q: ParsedQuery, ctx: MatchContext) {
  if (s.day < f.from || s.day > f.to) return false;
  if (f.customerId && s.customerId !== f.customerId) return false;
  if (f.methods.length) {
    const m = billMethods(s);
    if (!f.methods.some((x) => m.has(x))) return false;
  }
  if (f.statuses.length) {
    const st = saleStatus(s);
    const ok = f.statuses.some((x) => (x === "late" ? ctx.lateIds.has(s.id) : x === "returned" ? st === "partially_returned" : x === st));
    if (!ok) return false;
  }
  return matchesQuery(s, q, ctx);
}

/* ------------------------------ the query ------------------------------ */

export interface BillsResult {
  filter: BillFilter;
  bills: Sale[]; // newest first
  stats: DayStats;
  lateIds: Set<string>;
  customers: Map<string, Customer>;
  ms: number;
}

/**
 * Bills for a filter, plus the summary of that selection.
 * Unfiltered (date only): bills of those days, corrections made on those days (a return today on an
 * older bill counts today, like the cash drawer) and udhaar received on those days.
 * Filtered: the matching bills and only their own corrections inside the range.
 */
export async function queryBills(shopId: string, f: BillFilter): Promise<BillsResult> {
  const t0 = performance.now();
  const lo: [string, string] = [shopId, f.from];
  const hi: [string, string] = [shopId, f.to];
  const [rawSales, customersArr, closes] = await Promise.all([
    f.customerId
      ? db.sales.where("customerId").equals(f.customerId).filter((s) => s.shopId === shopId && s.day >= f.from && s.day <= f.to).toArray()
      : db.sales.where("[shopId+day]").between(lo, hi, true, true).toArray(),
    db.customers.where("shopId").equals(shopId).toArray(),
    f.statuses.includes("late") ? db.cashEntries.where("[shopId+day]").between(lo, hi, true, true).filter((e) => e.kind === "close").toArray() : Promise.resolve([]),
  ]);
  const customers = new Map(customersArr.map((c) => [c.id, c]));
  const firstClose = new Map<string, number>();
  for (const c of closes) if (!firstClose.has(c.day) || c.createdAt < firstClose.get(c.day)!) firstClose.set(c.day, c.createdAt);
  const lateIds = new Set(rawSales.filter((s) => firstClose.has(s.day) && s.createdAt > firstClose.get(s.day)!).map((s) => s.id));
  const q = parseQuery(f.q);
  const ctx = { customers, lateIds };
  const bills = rawSales.filter((s) => matchesBill(s, f, q, ctx)).sort((a, b) => b.createdAt - a.createdAt);

  const filtered = isFiltered(f);
  let corrections: SaleCorrection[] = await db.corrections.where("[shopId+day]").between(lo, hi, true, true).toArray();
  let received: LedgerEntry[] = [];
  if (filtered) {
    const ids = new Set(bills.map((s) => s.id));
    corrections = corrections.filter((c) => ids.has(c.saleId));
  } else {
    const { start, end } = rangeMs(f.from, f.to);
    received = await db.ledger.where("createdAt").between(start, end, true, true).filter((e) => e.shopId === shopId && e.type === "credit").toArray();
  }
  const ids = new Set(bills.map((s) => s.id));
  const older = [...new Set(corrections.map((c) => c.saleId).filter((id) => !ids.has(id)))];
  const olderBills = older.length ? (await db.sales.bulkGet(older)).filter((s): s is Sale => !!s) : [];
  const stats = computeDayStats(bills, corrections, received, new Map(olderBills.map((s) => [s.id, s])));
  return { filter: f, bills, stats, lateIds, customers, ms: round2(performance.now() - t0) };
}

/* ------------------------------ export ------------------------------ */

export function salesCSVRows(sales: Sale[], customerName: (id?: string) => string | undefined) {
  return [...sales]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => [
      s.id,
      s.day,
      fmtDate(s.createdAt, "en", "HH:mm"),
      s.items.map(csvItem).join("; "),
      s.total,
      s.cost,
      s.payment,
      ...salePaymentCSV(s),
      s.customerId ? customerName(s.customerId) : "",
      s.status ?? "active",
      s.returnedTotal ?? 0,
      netTotal(s),
    ]);
}
