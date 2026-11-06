import type { useTranslations } from "next-intl";
import { v4 as uuid } from "uuid";
import {
  CASH_MANUAL_KINDS,
  CASH_OUT_KINDS,
  db,
  DENOMS,
  EXPENSE_CATEGORIES,
  type CashEntry,
  type CashKind,
  type CashManualKind,
  type ExpenseCategory,
  type LedgerEntry,
  type Locale,
  type Sale,
  type SaleCorrection,
  type Shop,
} from "./db";
import { dayKey, fmtDate } from "./dates";
import { formatINR, round2 } from "./money";
import { enqueue } from "./ops";
import { partSum, paymentsOf, refundsOf } from "./payments";

/**
 * Daily cash closing (आज का गल्ला). Expected cash in the drawer for a day =
 *   opening + (bill cash net of change + udhaar cash payments + cash added)
 *           − (cash refunds + expenses + supplier payments + owner withdrawals + bank deposits).
 * UPI is reported separately: it never enters the drawer.
 */

export class CashError extends Error {
  constructor(public code: "amount" | "reason" | "category" | "future" | "notFound" | "kind") {
    super(code);
  }
}

const EPS = 0.005;
export const COINS = "coins";
const CASH_MANUAL_KINDS_SET = new Set<CashKind>(CASH_MANUAL_KINDS);

/** Entries still in force: not a void, not voided. */
export function activeEntries(entries: CashEntry[]) {
  const voided = new Set(entries.filter((e) => e.kind === "void" && e.voidsId).map((e) => e.voidsId as string));
  return entries.filter((e) => e.kind !== "void" && !voided.has(e.id)).sort((a, b) => a.createdAt - b.createdAt);
}

export const latestClose = (entries: CashEntry[]) => activeEntries(entries).filter((e) => e.kind === "close").pop();

/** The counted closing of the most recent closed day before `day` (carried into `day` as opening). */
export function carriedFrom(earlier: CashEntry[], day: string): { day: string; amount: number } | null {
  const byDay = new Map<string, CashEntry[]>();
  for (const e of earlier) if (e.day < day) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  for (const d of [...byDay.keys()].sort().reverse()) {
    const c = latestClose(byDay.get(d)!);
    if (c) return { day: d, amount: c.amount };
  }
  return null;
}

export const denomTotal = (denoms: Record<string, number>) =>
  round2(
    Object.entries(denoms).reduce((a, [k, n]) => a + (k === COINS ? Number(n) || 0 : Number(k) * (Math.floor(Number(n)) || 0)), 0),
  );

export interface CashDayInput {
  day: string;
  sales: Sale[]; // bills issued or payments received on the day
  corrections: SaleCorrection[]; // returns / cancellations made that day
  ledger: LedgerEntry[]; // ledger rows created that day
  entries: CashEntry[]; // drawer entries of the day (incl. voids / closes)
  carried: { day: string; amount: number } | null;
}

export interface CashDay {
  day: string;
  opening: number;
  openingSource: "entry" | "carried" | "none";
  openingEntry?: CashEntry;
  carried: { day: string; amount: number } | null;
  cashIn: { sales: number; udhaar: number; added: number; total: number };
  cashOut: { refunds: number; expense: number; supplier: number; withdrawal: number; bank: number; total: number };
  /** Cash handed over by customers and change given back (info: sales cash = tendered − change). */
  tendered: number;
  change: number;
  expected: number;
  upi: { sales: number; udhaar: number; refunds: number; pending: number; net: number };
  expensesByCategory: Partial<Record<ExpenseCategory, number>>;
  /** Manual entries in force (in/out), oldest first; voided ones are listed separately. */
  manual: CashEntry[];
  voided: CashEntry[];
  closes: CashEntry[];
  close?: CashEntry;
  closed: boolean;
  /** counted − expected now (negative = कम / short, positive = ज़्यादा / over). */
  diff: number | null;
  /** Bills, payments or entries recorded after the day was first closed. */
  late: { count: number; ids: Set<string>; drift: number };
}

export function computeCashDay(input: CashDayInput): CashDay {
  const { day, sales, corrections, ledger, entries, carried } = input;
  const active = activeEntries(entries);
  const voidedIds = new Set(entries.filter((e) => e.kind === "void" && e.voidsId).map((e) => e.voidsId));
  const openingEntry = active.filter((e) => e.kind === "opening").pop();
  const opening = openingEntry ? openingEntry.amount : (carried?.amount ?? 0);
  const sum = (k: CashKind) => round2(active.filter((e) => e.kind === k).reduce((a, e) => a + e.amount, 0));

  let salesCash = 0;
  let tendered = 0;
  let change = 0;
  let upiSales = 0;
  let upiPending = 0;
  for (const s of sales) {
    const parts = paymentsOf(s).filter((p) => (p.confirmedAt === undefined ? s.day : dayKey(p.confirmedAt)) === day);
    salesCash += partSum(parts, "cash");
    upiSales += partSum(parts, "upi", "paid");
    upiPending += (s.status ?? "active") === "cancelled" ? 0 : partSum(parts, "upi", "pending");
    for (const p of parts) {
      if (p.method !== "cash" || p.tendered === undefined) continue;
      tendered += p.tendered;
      change += p.change ?? 0;
    }
  }
  const payments = ledger.filter((e) => e.type === "credit" && e.kind !== "return");
  const udhaarCash = payments.filter((e) => e.method !== "upi").reduce((a, e) => a + e.amount, 0);
  const udhaarUpi = payments.filter((e) => e.method === "upi").reduce((a, e) => a + e.amount, 0);
  const refunds = corrections.flatMap(refundsOf);
  const refundCash = refunds.filter((r) => r.method === "cash").reduce((a, r) => a + r.amount, 0);
  const refundUpi = refunds.filter((r) => r.method === "upi").reduce((a, r) => a + r.amount, 0);

  const cashIn = { sales: round2(salesCash), udhaar: round2(udhaarCash), added: sum("added"), total: 0 };
  cashIn.total = round2(cashIn.sales + cashIn.udhaar + cashIn.added);
  const cashOut = { refunds: round2(refundCash), expense: sum("expense"), supplier: sum("supplier"), withdrawal: sum("withdrawal"), bank: sum("bank"), total: 0 };
  cashOut.total = round2(cashOut.refunds + cashOut.expense + cashOut.supplier + cashOut.withdrawal + cashOut.bank);
  const expected = round2(opening + cashIn.total - cashOut.total);

  const expensesByCategory: Partial<Record<ExpenseCategory, number>> = {};
  for (const e of active) if (e.kind === "expense") expensesByCategory[e.category ?? "other"] = round2((expensesByCategory[e.category ?? "other"] ?? 0) + e.amount);

  const closes = entries.filter((e) => e.kind === "close").sort((a, b) => a.createdAt - b.createdAt);
  const close = latestClose(entries);
  const firstCloseAt = closes[0]?.createdAt;
  const ids = new Set<string>();
  if (firstCloseAt !== undefined) {
    for (const s of sales) {
      if (paymentsOf(s).some((p) => p.confirmedAt !== undefined && dayKey(p.confirmedAt) === day && p.confirmedAt > firstCloseAt)) ids.add(s.id);
    }
    for (const x of [...sales.filter((s) => s.day === day), ...corrections, ...payments]) if (x.createdAt > firstCloseAt) ids.add(x.id);
    for (const e of entries) if (e.kind !== "close" && (e.createdAt > firstCloseAt || e.afterClose)) ids.add(e.id);
  }
  const upiNet = round2(upiSales + udhaarUpi - refundUpi);
  return {
    day,
    opening,
    openingSource: openingEntry ? "entry" : carried ? "carried" : "none",
    openingEntry,
    carried,
    cashIn,
    cashOut,
    tendered: round2(tendered),
    change: round2(change),
    expected,
    upi: { sales: round2(upiSales), udhaar: round2(udhaarUpi), refunds: round2(refundUpi), pending: round2(upiPending), net: upiNet },
    expensesByCategory,
    manual: active.filter((e) => (CASH_MANUAL_KINDS_SET as Set<string>).has(e.kind)),
    voided: entries.filter((e) => voidedIds.has(e.id)),
    closes,
    close,
    closed: !!close,
    diff: close ? round2(close.amount - expected) : null,
    late: { count: ids.size, ids, drift: close?.expected !== undefined ? round2(expected - close.expected) : 0 },
  };
}

/* ------------------------------ loading ------------------------------ */

async function dayInput(shopId: string, day: string): Promise<CashDayInput> {
  const [sales, corrections, entries, ledger, earlier] = await Promise.all([
    db.sales.where("shopId").equals(shopId).filter((s) => s.day === day || paymentsOf(s).some((p) => p.confirmedAt !== undefined && dayKey(p.confirmedAt) === day)).toArray(),
    db.corrections.where("[shopId+day]").equals([shopId, day]).toArray(),
    db.cashEntries.where("[shopId+day]").equals([shopId, day]).toArray(),
    db.ledger.where("shopId").equals(shopId).filter((e) => dayKey(e.createdAt) === day).toArray(),
    db.cashEntries.where("shopId").equals(shopId).filter((e) => e.day < day && (e.kind === "close" || e.kind === "void")).toArray(),
  ]);
  return { day, sales, corrections, ledger, entries, carried: carriedFrom(earlier, day) };
}

export async function loadCashDay(shopId: string, day: string) {
  return computeCashDay(await dayInput(shopId, day));
}

/** Closed days, newest first (with their summaries). A re-opened day drops out until it is closed again. */
export async function loadClosings(shopId: string, limit = 30) {
  const all = await db.cashEntries.where("shopId").equals(shopId).toArray();
  const days = [...new Set(all.filter((e) => e.kind === "close").map((e) => e.day))].sort().reverse().slice(0, limit + 5);
  return (await Promise.all(days.map((d) => loadCashDay(shopId, d)))).filter((d) => d.closed).slice(0, limit);
}

/** Every day with bills or drawer entries, oldest first (for the CSV). */
export async function loadAllCashDays(shopId: string) {
  const days = new Set<string>();
  for (const e of await db.cashEntries.where("shopId").equals(shopId).toArray()) days.add(e.day);
  for (const s of await db.sales.where("shopId").equals(shopId).toArray()) {
    days.add(s.day);
    for (const p of paymentsOf(s)) if (p.confirmedAt !== undefined) days.add(dayKey(p.confirmedAt));
  }
  return Promise.all([...days].sort().map((d) => loadCashDay(shopId, d)));
}

/* ------------------------------ writes (append-only) ------------------------------ */

const TABLES = () => [db.cashEntries, db.outbox, db.sales, db.corrections, db.ledger];
const clean = (v?: string) => v?.trim() || undefined;

async function put(entry: CashEntry) {
  await db.cashEntries.add(entry);
  await enqueue("cash_entries", "upsert", entry.id, entry);
  return entry;
}

function checkDay(day: string, now: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > dayKey(now)) throw new CashError("future");
}
function checkAmount(v: number) {
  if (!Number.isFinite(v) || v < 0) throw new CashError("amount");
  return round2(v);
}

/** Expense, supplier payment, owner withdrawal, cash added or bank deposit. On a closed day a reason is required. */
export async function addCashEntry(opts: {
  shopId: string;
  day: string;
  kind: CashManualKind;
  amount: number;
  category?: ExpenseCategory;
  note?: string;
  supplierId?: string;
  supplierName?: string;
  reason?: string;
  byName?: string;
}) {
  const now = Date.now();
  checkDay(opts.day, now);
  if (!CASH_MANUAL_KINDS_SET.has(opts.kind)) throw new CashError("kind");
  const amount = checkAmount(opts.amount);
  if (amount <= 0) throw new CashError("amount");
  if (opts.kind === "expense" && !(EXPENSE_CATEGORIES as readonly string[]).includes(opts.category ?? "")) throw new CashError("category");
  return db.transaction("rw", TABLES(), async () => {
    const day = await loadCashDay(opts.shopId, opts.day);
    const reason = clean(opts.reason);
    if (day.closed && !reason) throw new CashError("reason");
    return put({
      id: uuid(),
      shopId: opts.shopId,
      day: opts.day,
      kind: opts.kind,
      amount,
      category: opts.kind === "expense" ? opts.category : undefined,
      note: clean(opts.note)?.slice(0, 200),
      supplierId: opts.kind === "supplier" ? clean(opts.supplierId) : undefined,
      supplierName: opts.kind === "supplier" ? clean(opts.supplierName)?.slice(0, 80) : undefined,
      reason,
      afterClose: day.closed || undefined,
      byName: clean(opts.byName),
      createdAt: now,
    });
  });
}

/** Opening cash for a day. A reason is required when it differs from the carried closing count (or the day is closed). */
export async function setOpening(opts: { shopId: string; day: string; amount: number; reason?: string; byName?: string }) {
  const now = Date.now();
  checkDay(opts.day, now);
  const amount = checkAmount(opts.amount);
  return db.transaction("rw", TABLES(), async () => {
    const day = await loadCashDay(opts.shopId, opts.day);
    const reason = clean(opts.reason);
    const differs = Math.abs(amount - (day.carried?.amount ?? 0)) > EPS;
    if ((differs || day.closed) && !reason) throw new CashError("reason");
    return put({ id: uuid(), shopId: opts.shopId, day: opts.day, kind: "opening", amount, reason, afterClose: day.closed || undefined, byName: clean(opts.byName), createdAt: now });
  });
}

/** Cancel an entry (logged, with a reason). Voiding a close re-opens the day. */
export async function voidCashEntry(opts: { entryId: string; reason: string; byName?: string }) {
  const reason = clean(opts.reason);
  if (!reason) throw new CashError("reason");
  return db.transaction("rw", TABLES(), async () => {
    const target = await db.cashEntries.get(opts.entryId);
    if (!target || target.kind === "void") throw new CashError("notFound");
    const day = await loadCashDay(target.shopId, target.day);
    if (day.voided.some((e) => e.id === target.id)) throw new CashError("notFound");
    return put({
      id: uuid(),
      shopId: target.shopId,
      day: target.day,
      kind: "void",
      amount: target.amount,
      voidsId: target.id,
      reason,
      afterClose: day.closed || undefined,
      byName: clean(opts.byName),
      createdAt: Date.now(),
    });
  });
}

/**
 * Close the day with the counted cash (plain total or notes). The expected amount and the difference
 * are saved with it; closing again later is a logged correction and needs a reason.
 */
export async function closeDay(opts: { shopId: string; day: string; counted?: number; denoms?: Record<string, number>; reason?: string; byName?: string }) {
  const now = Date.now();
  checkDay(opts.day, now);
  let denoms: Record<string, number> | undefined;
  if (opts.denoms) {
    denoms = {};
    for (const [k, n] of Object.entries(opts.denoms)) {
      if (k !== COINS && !(DENOMS as readonly number[]).includes(Number(k))) throw new CashError("amount");
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0 || (k !== COINS && !Number.isInteger(v))) throw new CashError("amount");
      if (v > 0) denoms[k] = k === COINS ? round2(v) : v;
    }
  }
  const counted = checkAmount(denoms ? denomTotal(denoms) : (opts.counted ?? NaN));
  return db.transaction("rw", TABLES(), async () => {
    const day = await loadCashDay(opts.shopId, opts.day);
    const reason = clean(opts.reason);
    if (day.closed && !reason) throw new CashError("reason");
    return put({
      id: uuid(),
      shopId: opts.shopId,
      day: opts.day,
      kind: "close",
      amount: counted,
      expected: day.expected,
      diff: round2(counted - day.expected),
      denoms,
      reason,
      afterClose: day.closed || undefined,
      byName: clean(opts.byName),
      createdAt: now,
    });
  });
}

/* ------------------------------ sharing / export ------------------------------ */

type T = ReturnType<typeof useTranslations>;

/** WhatsApp day summary. `t` must be the root translator. */
export function cashDayText(t: T, d: CashDay, shop: Shop, locale: Locale) {
  const r = (n: number) => formatINR(n);
  const lines = [
    t("cash.waHeader", { shop: shop.name, date: fmtDate(d.day, locale, "d MMM yyyy") }),
    t("cash.waOpening", { amount: r(d.opening) }),
    t("cash.waIn", { amount: r(d.cashIn.total), sales: r(d.cashIn.sales), udhaar: r(d.cashIn.udhaar), added: r(d.cashIn.added) }),
    t("cash.waOut", { amount: r(d.cashOut.total), refunds: r(d.cashOut.refunds), expense: r(d.cashOut.expense), supplier: r(d.cashOut.supplier), withdrawal: r(d.cashOut.withdrawal), bank: r(d.cashOut.bank) }),
    t("cash.waExpected", { amount: r(d.expected) }),
  ];
  if (d.close) {
    lines.push(t("cash.waCounted", { amount: r(d.close.amount) }));
    const diff = d.diff ?? 0;
    lines.push(Math.abs(diff) < EPS ? t("cash.waMatch") : diff < 0 ? t("cash.waShort", { amount: r(-diff) }) : t("cash.waOver", { amount: r(diff) }));
    if (d.close.reason) lines.push(t("cash.waReason", { reason: d.close.reason }));
  } else lines.push(t("cash.waOpen"));
  lines.push(t("cash.waUpi", { amount: r(d.upi.net) }) + (d.upi.pending > 0 ? ` · ${t("cash.waUpiPending", { amount: r(d.upi.pending) })}` : ""));
  if (d.late.count) lines.push(t("cash.waLate", { count: d.late.count }));
  lines.push("— Vyaplio");
  return lines.join("\n");
}

export const CASH_DAYS_CSV_HEADERS = [
  "date", "opening", "opening_source", "cash_sales", "udhaar_cash", "cash_added", "cash_refunds", "expenses", "supplier_payments",
  "owner_withdrawals", "bank_deposits", "expected", "counted", "difference", "close_reason", "closed_at", "late_entries", "upi_net", "upi_pending",
];

export function cashDayCSVRow(d: CashDay) {
  return [
    d.day, d.opening, d.openingSource, d.cashIn.sales, d.cashIn.udhaar, d.cashIn.added, d.cashOut.refunds, d.cashOut.expense,
    d.cashOut.supplier, d.cashOut.withdrawal, d.cashOut.bank, d.expected, d.close?.amount ?? "", d.diff ?? "", d.close?.reason ?? "",
    d.close ? fmtDate(d.close.createdAt, "en", "yyyy-MM-dd HH:mm") : "", d.late.count, d.upi.net, d.upi.pending,
  ];
}

export const CASH_ENTRIES_CSV_HEADERS = ["day", "time", "kind", "amount", "category", "supplier", "note", "reason", "voids", "after_close", "by"];

export function cashEntryCSVRows(entries: CashEntry[]) {
  return [...entries]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => [
      e.day, fmtDate(e.createdAt, "en", "yyyy-MM-dd HH:mm"), e.kind, e.amount, e.category ?? "", e.supplierName ?? e.supplierId ?? "",
      e.note ?? "", e.reason ?? "", e.voidsId ?? "", e.afterClose ? "yes" : "", e.byName ?? "",
    ]);
}

export const isCashOut = (k: CashKind) => CASH_OUT_KINDS.includes(k);
