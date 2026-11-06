/**
 * The हिसाब (profit) screen's data: load a date range (same presets / custom range and local-day
 * boundaries as the bills screen, see bills.ts) and turn it into a ProfitReport, a WhatsApp summary
 * and a CSV. All numbers come from profit.ts.
 */
import type { useTranslations } from "next-intl";
import { format, parseISO } from "date-fns";
import { ALL_FROM, presetRange, rangeMs } from "./bills";
import { db, type Locale, type Sale, type Shop } from "./db";
import { dayKey, fmtDate } from "./dates";
import { formatINR, round2 } from "./money";
import { names } from "./names";
import { buildReport, coveragePct, topItems, type ProfitReport } from "./profit";

type T = ReturnType<typeof useTranslations>;

export const REPORT_PRESETS = ["today", "week", "month"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number] | "custom";
export interface ReportRange {
  preset: ReportPreset;
  from: string;
  to: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string | null | undefined): v is string => !!v && DAY_RE.test(v) && format(parseISO(v), "yyyy-MM-dd") === v;

export const reportRange = (preset: Exclude<ReportPreset, "custom">, now: number): ReportRange => ({ preset, ...presetRange(preset, now) });

/** Which preset (if any) a range is, today. */
export function reportPresetOf(from: string, to: string, now: number): ReportPreset {
  for (const p of REPORT_PRESETS) {
    const r = presetRange(p, now);
    if (r.from === from && r.to === to) return p;
  }
  return "custom";
}

/** Custom range from two picked dates: ordered, never in the future, never before ALL_FROM. */
export function customRange(a: string, b: string, now: number): ReportRange | null {
  let from = isDay(a) ? a : isDay(b) ? b : null;
  let to = isDay(b) ? b : from;
  if (!from || !to) return null;
  if (from > to) [from, to] = [to, from];
  const today = dayKey(now);
  if (to > today) to = today;
  if (from > today) from = today;
  if (from < ALL_FROM) from = ALL_FROM;
  return { preset: reportPresetOf(from, to, now), from, to };
}

/** `?range=week` or `?from=…&to=…` (same shape as the bills screen's deep links). */
export function rangeFromParams(search: string, now: number): ReportRange {
  const p = new URLSearchParams(search);
  const r = p.get("range");
  if (r && (REPORT_PRESETS as readonly string[]).includes(r)) return reportRange(r as Exclude<ReportPreset, "custom">, now);
  return customRange(p.get("from") ?? "", p.get("to") ?? "", now) ?? reportRange("today", now);
}

export function rangeToParams(r: ReportRange): string {
  if (r.preset === "custom") return new URLSearchParams({ from: r.from, to: r.to }).toString();
  return r.preset === "today" ? "" : `range=${r.preset}`;
}

export async function loadReport(shopId: string, from: string, to: string): Promise<ProfitReport> {
  const lo: [string, string] = [shopId, from];
  const hi: [string, string] = [shopId, to];
  const { start, end } = rangeMs(from, to);
  const [sales, corrections, products, ledger, cash, moves] = await Promise.all([
    db.sales.where("[shopId+day]").between(lo, hi, true, true).toArray(),
    db.corrections.where("[shopId+day]").between(lo, hi, true, true).toArray(),
    db.products.where("shopId").equals(shopId).toArray(),
    db.ledger.where("createdAt").between(start, end, true, true).filter((e) => e.shopId === shopId).toArray(),
    db.cashEntries.where("[shopId+day]").between(lo, hi, true, true).toArray(),
    db.stockMoves.where("createdAt").between(start, end, true, true).filter((m) => m.shopId === shopId && (m.reason === "damage" || m.reason === "theft")).toArray(),
  ]);
  const have = new Set(sales.map((s) => s.id));
  const older = [...new Set(corrections.map((c) => c.saleId).filter((id) => !have.has(id)))];
  const olderBills = older.length ? (await db.sales.bulkGet(older)).filter((s): s is Sale => !!s) : [];
  const report = buildReport({ from, to, sales, corrections, saleById: new Map(olderBills.map((s) => [s.id, s])), products, ledger, cash, moves });
  const [bills, supplierUpi] = await Promise.all([
    db.purchases.where("[shopId+day]").between(lo, hi, true, true).toArray(),
    db.supplierLedger.where("shopId").equals(shopId).filter((e) => e.type === "payment" && e.method === "upi" && e.day >= from && e.day <= to).toArray(),
  ]);
  report.purchases = {
    total: round2(bills.reduce((a, b) => a + b.total, 0)),
    bills: bills.length,
    paidUpi: round2(supplierUpi.reduce((a, e) => a + e.amount, 0)),
  };
  return report;
}

/* ------------------------------ wording ------------------------------ */

export function rangeText(t: T, r: Pick<ReportRange, "preset" | "from" | "to">, locale: Locale) {
  if (r.preset !== "custom") return t(`report.preset_${r.preset}`);
  if (r.from === r.to) return fmtDate(r.from, locale, "d MMM yyyy");
  return `${fmtDate(r.from, locale, "d MMM")} – ${fmtDate(r.to, locale, "d MMM yyyy")}`;
}

/** Plain-language lines explaining the numbers (screen + WhatsApp). `t` = root translator. */
export function explainLines(t: T, r: ProfitReport): string[] {
  const m = (n: number) => formatINR(n);
  const out: string[] = [];
  if (Math.abs(r.netSales) < 0.005 && r.billCount === 0) {
    out.push(t("report.exNoSales"));
  } else {
    out.push(r.returns > 0.005 ? t("report.exSales", { amount: m(r.netSales), returns: m(r.returns) }) : t("report.exSalesNoReturns", { amount: m(r.netSales) }));
    if (r.complete) out.push(t("report.exMarginAll", { amount: m(r.margin), cost: m(r.cogs) }));
    else out.push(t("report.exMarginPart", { pct: coveragePct(r), known: m(r.knownSales), amount: m(r.margin), unknown: m(r.unknownSales) }));
    if (r.filledSales > 0.005) out.push(t("report.exFilled", { amount: m(r.filledSales) }));
  }
  out.push(r.expenses.total > 0 || r.losses.total > 0 ? t("report.exCosts", { expenses: m(r.expenses.total), losses: m(r.losses.total) }) : t("report.exNoCosts"));
  if (r.losses.unvalued) out.push(t("report.exLossUnvalued", { count: r.losses.unvalued }));
  out.push(r.netEarned >= 0 ? t("report.exNet", { amount: m(r.netEarned) }) : t("report.exNetLoss", { amount: m(-r.netEarned) }));
  if (r.onCredit > 0.005) out.push(t("report.exCredit", { credit: m(r.onCredit), margin: m(Math.max(0, r.marginOnCredit)) }));
  if (r.upiPending > 0.005) out.push(t("report.exUpiPending", { amount: m(r.upiPending) }));
  const notExp = (["withdrawal", "supplier", "bank"] as const).filter((k) => r.notExpenses[k] > 0.005).map((k) => t(`report.exNe_${k}`, { amount: m(r.notExpenses[k]) }));
  if (notExp.length) out.push(t("report.exNotExpense", { list: notExp.join(", ") }));
  if (r.udhaarReceived > 0.005) out.push(t("report.exReceived", { amount: m(r.udhaarReceived) }));
  if (r.purchases && r.purchases.bills > 0) out.push(t("report.exPurchases", { amount: m(r.purchases.total), count: r.purchases.bills }));
  return out;
}

/** WhatsApp summary. */
export function reportText(t: T, r: ProfitReport, shop: Shop, range: ReportRange, locale: Locale) {
  const m = (n: number) => formatINR(n);
  const lines = [
    t("report.waHeader", { shop: shop.name, range: rangeText(t, range, locale) }),
    t("report.waSales", { amount: m(r.netSales), count: r.billCount }),
    t("report.waMargin", { amount: m(r.margin) }) + (r.complete ? "" : ` (${t("report.coverage", { pct: coveragePct(r) })})`),
    t("report.waExpenses", { amount: m(r.expenses.total) }),
    t("report.waLosses", { amount: m(r.losses.total) }),
    t("report.waNet", { amount: m(r.netEarned) }),
    t("report.waMoney", { collected: m(r.collected), credit: m(r.onCredit) }),
  ];
  const top = topItems(r, 3);
  if (top.length) lines.push(t("report.waTop", { items: top.map((i) => `${names(i, locale).primary} ${m(i.margin)}`).join(", ") }));
  if (r.missing.length) lines.push(t("report.waMissing", { count: r.missing.length, amount: m(r.unknownSales) }));
  lines.push(t("report.waNote"), "— Vyaplio");
  return lines.join("\n");
}

export const REPORT_CSV_HEADERS = ["section", "name_hi", "name_en", "unit", "qty", "net_sales", "cost", "margin", "margin_pct", "note"];

/** One CSV: summary rows, then every item (known cost), items without a buy price, and stock losses. */
export function reportCSVRows(r: ProfitReport): (string | number)[][] {
  const sum = (k: string, v: number, note = "") => ["summary", k, "", "", "", v, "", "", "", note];
  const rows: (string | number)[][] = [
    sum("range", 0, `${r.from}..${r.to}`),
    sum("net_sales", r.netSales),
    sum("returns", r.returns),
    sum("known_cost_sales", r.knownSales),
    sum("unknown_cost_sales", r.unknownSales),
    sum("coverage_pct", coveragePct(r)),
    sum("cost_of_goods_sold", r.cogs),
    sum("gross_margin", r.margin),
    ...Object.entries(r.expenses.byCategory).map(([k, v]) => sum(`expense_${k}`, v ?? 0)),
    sum("expenses_total", r.expenses.total),
    sum("stock_losses", r.losses.total, r.losses.unvalued ? `${r.losses.unvalued} not valued (no buy price)` : ""),
    sum("net_earned", r.netEarned),
    sum("collected_cash_upi", r.collected),
    sum("on_credit_udhaar", r.onCredit, "sold on credit: profit not yet collected"),
    sum("upi_pending", r.upiPending),
    sum("margin_on_credit_approx", r.marginOnCredit),
    sum("udhaar_received", r.udhaarReceived, "older udhaar coming in: not new profit"),
    sum("owner_withdrawal", r.notExpenses.withdrawal, "not an expense"),
    sum("supplier_payments", r.notExpenses.supplier, "not an expense (stock bought)"),
    sum("bank_deposit", r.notExpenses.bank, "not an expense"),
    ...(r.purchases
      ? [
          sum("purchases_total", r.purchases.total, `${r.purchases.bills} supplier bills: not an expense (cost counted when sold)`),
          sum("supplier_upi_payments", r.purchases.paidUpi, "not an expense (not from the galla)"),
        ]
      : []),
  ];
  for (const i of [...r.items].sort((a, b) => b.margin - a.margin))
    rows.push(["item", i.nameHi, i.nameEn, i.unit, i.qty, i.sales, i.cost, i.margin, i.pct ?? "", i.flags.join(" ")]);
  for (const i of r.missing) rows.push(["no_buy_price", i.nameHi, i.nameEn, i.unit, i.qty, i.sales, "", "", "", "profit unknown"]);
  for (const l of r.losses.rows) rows.push([`loss_${l.reason}`, l.nameHi, l.nameEn, l.unit, l.qty, "", l.value ?? "", "", "", l.value === null ? "no buy price" : l.estimated ? "today's buy price" : ""]);
  return rows;
}
