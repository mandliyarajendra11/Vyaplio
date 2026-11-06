/**
 * Honest profit (हिसाब). Three rules:
 *  1. A sale whose buy price is not known adds no profit and no cost: it is left out of the margin
 *     and shown as "coverage" (रक़म के 82% बिक्री का मुनाफ़ा पता है) with a list of what is missing.
 *     Old bill lines (before `costKnown` existed) with cost 0 are read as unknown, never as free.
 *  2. Gross margin = net sales (after returns) − cost of goods sold, both over known-cost lines only.
 *     Returns reverse their own line's sale value and cost on the day of the return.
 *  3. Money earned after expenses = gross margin − drawer expenses (गल्ला categories) − damage/theft
 *     valued at cost. Owner withdrawals, supplier payments and bank deposits are NOT expenses.
 * Udhaar: the margin is earned when sold, but the money is not in hand yet – shown separately.
 */
import { lineTotal } from "./units";
import type { CashEntry, CorrectionLine, ExpenseCategory, LedgerEntry, Product, Sale, SaleCorrection, SaleItem, StockMove } from "./db";
import { DAY_MS, dayKey } from "./dates";
import { round2 } from "./money";
import { moneySplit } from "./payments";

/** A buy price entered more than this many days before the sale is flagged "old – check". */
export const STALE_COST_DAYS = 90;
/** Items earning less than this share of their selling price are listed as "low margin". */
export const LOW_MARGIN_PCT = 10;
const EPS = 0.005;

type CostLine = { cost: number; costKnown?: boolean };

/** Whether a bill / correction line carries a real buy price (legacy rule: cost 0 = unknown). */
export const costKnown = (l: CostLine) => (typeof l.costKnown === "boolean" ? l.costKnown && Number.isFinite(l.cost) : l.cost > 0);

/** The cost fields stored on a bill line at sale time. */
export function costSnapshot(p: Pick<Product, "buyPrice" | "buyPriceAt" | "updatedAt" | "createdAt">): Pick<SaleItem, "cost" | "costKnown" | "costAt"> {
  const known = Number.isFinite(p.buyPrice) && p.buyPrice > 0;
  if (!known) return { cost: 0, costKnown: false };
  return { cost: p.buyPrice, costKnown: true, costAt: p.buyPriceAt ?? p.updatedAt ?? p.createdAt };
}

export type CostFlag = "missing" | "aboveSell" | "stale" | "filled";

/** What to check about one bill line's cost (null = fine). */
export function costFlag(l: Pick<SaleItem, "cost" | "costKnown" | "costAt" | "costFilled" | "price">, soldAt: number): CostFlag | null {
  if (!costKnown(l)) return "missing";
  if (l.cost > l.price + 1e-9) return "aboveSell";
  if (l.costAt && soldAt - l.costAt > STALE_COST_DAYS * DAY_MS) return "stale";
  if (l.costFilled) return "filled";
  return null;
}

/** Product-level cost warning (stock screen / form). */
export function productCostFlag(p: Pick<Product, "buyPrice" | "sellPrice" | "buyPriceAt" | "updatedAt">, now: number): Exclude<CostFlag, "filled"> | null {
  if (!(p.buyPrice > 0)) return "missing";
  if (p.buyPrice > p.sellPrice + 1e-9) return "aboveSell";
  const at = p.buyPriceAt ?? p.updatedAt;
  if (at && now - at > STALE_COST_DAYS * DAY_MS) return "stale";
  return null;
}

/* ------------------------------ margin over bills ------------------------------ */

export interface MarginTotals {
  /** Σ bills − Σ returns (the same "net sales" every other screen shows). */
  netSales: number;
  /** Net sales of lines whose buy price is known. */
  knownSales: number;
  /** Cost of goods sold for those lines (returns reversed). */
  cogs: number;
  /** knownSales − cogs. */
  margin: number;
  /** Net sales with no buy price (their profit is unknown, not counted). */
  unknownSales: number;
  /** knownSales / netSales, 0..1 (1 when there is nothing unknown). */
  coverage: number;
  /** false when some sales have no buy price. */
  complete: boolean;
  /** Known sales whose cost was filled in later (estimate). */
  filledSales: number;
}

/** The bill line a correction line points at (its current cost, e.g. filled in later), else the line itself. */
function resolveLine(l: CorrectionLine, sale: Sale | undefined): CostLine & { costFilled?: boolean } {
  const it = sale?.items[l.index];
  if (it && it.productId === l.productId) return it;
  return l;
}

export function coverageOf(knownSales: number, netSales: number, unknownSales: number) {
  if (Math.abs(unknownSales) < EPS) return 1;
  if (netSales <= EPS) return 0;
  return Math.min(1, Math.max(0, knownSales / netSales));
}

/** Coverage as a whole percentage that never rounds an incomplete figure up to 100. */
export const coveragePct = (m: Pick<MarginTotals, "coverage" | "complete">) => (m.complete ? 100 : Math.min(99, Math.floor(m.coverage * 100)));

/**
 * Margin of these bills and these corrections (each counted on its own day, like the money).
 * `saleById` resolves corrections of bills outside `sales` (a return today of last week's bill).
 */
export function marginTotals(sales: Sale[], corrections: SaleCorrection[], saleById?: Map<string, Sale>): MarginTotals {
  const byId = new Map(sales.map((s) => [s.id, s]));
  let gross = 0;
  let returned = 0;
  let known = 0;
  let cogs = 0;
  let filled = 0;
  for (const s of sales) {
    gross += s.total;
    for (const it of s.items) {
      if (!costKnown(it)) continue;
      known += lineTotal(it);
      cogs += it.qty * it.cost;
      if (it.costFilled) filled += lineTotal(it);
    }
  }
  for (const c of corrections) {
    returned += c.amount;
    const sale = byId.get(c.saleId) ?? saleById?.get(c.saleId);
    for (const l of c.lines) {
      const line = resolveLine(l, sale);
      if (!costKnown(line)) continue;
      known -= l.amount ?? l.qty * l.price;
      cogs -= l.qty * line.cost;
      if (line.costFilled) filled -= l.amount ?? l.qty * l.price;
    }
  }
  const netSales = round2(gross - returned);
  const knownSales = round2(known);
  const unknownSales = round2(netSales - knownSales);
  const coverage = coverageOf(knownSales, netSales, unknownSales);
  return {
    netSales,
    knownSales,
    cogs: round2(cogs),
    margin: round2(known - cogs),
    unknownSales,
    coverage,
    complete: Math.abs(unknownSales) < EPS,
    filledSales: round2(filled),
  };
}

/* ------------------------------ the report ------------------------------ */

export interface ItemRow {
  key: string;
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: SaleItem["unit"];
  /** Net quantity sold (after returns). */
  qty: number;
  sales: number;
  cost: number;
  margin: number;
  /** margin / sales × 100 (null when nothing net was sold). */
  pct: number | null;
  /** Lines needing a look: cost above selling price, old buy price, or filled in later. */
  flags: Exclude<CostFlag, "missing">[];
}

export interface MissingRow {
  key: string;
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: SaleItem["unit"];
  qty: number;
  sales: number;
  /** The product still exists on this phone (so a buy price can be added). */
  exists: boolean;
  /** The product has a buy price now (added after these bills). */
  buyPriceNow: number;
}

export interface LossRow {
  id: string;
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: SaleItem["unit"];
  reason: "damage" | "theft";
  qty: number;
  /** null = no buy price known: not valued (listed). */
  value: number | null;
  /** Valued with today's buy price (the move was recorded before costs were saved on it). */
  estimated: boolean;
  createdAt: number;
}

export interface ProfitReport extends MarginTotals {
  from: string;
  to: string;
  billCount: number;
  grossSales: number;
  returns: number;
  /** Money side of the net sales. */
  collected: number; // cash + confirmed UPI
  cash: number;
  upi: number;
  upiPending: number;
  onCredit: number;
  /** Margin share sold on udhaar (≈ margin × udhaar / net sales): earned, not yet in hand. */
  marginOnCredit: number;
  /** Udhaar payments received in the range (older sales' money coming in – not new profit). */
  udhaarReceived: number;
  expenses: { total: number; byCategory: Partial<Record<ExpenseCategory, number>>; count: number };
  losses: { total: number; rows: LossRow[]; unvalued: number };
  /** Gross margin − expenses − stock losses. */
  netEarned: number;
  /** Cash that left the drawer but is not an expense. */
  notExpenses: { withdrawal: number; supplier: number; bank: number };
  /** Supplier diary in the range (filled by loadReport): stock bought is not an expense either. */
  purchases?: { total: number; bills: number; paidUpi: number };
  items: ItemRow[];
  missing: MissingRow[];
}

export interface ReportInput {
  from: string;
  to: string;
  sales: Sale[]; // bills of the range
  corrections: SaleCorrection[]; // corrections made in the range
  /** Bills referenced by those corrections (may be older than the range). */
  saleById: Map<string, Sale>;
  products: Product[];
  ledger: LedgerEntry[]; // udhaar ledger entries created in the range
  cash: CashEntry[]; // drawer entries of the range's days (incl. voids)
  moves: StockMove[]; // stock moves created in the range
}

const keyOf = (l: { productId: string; nameHi: string }) => l.productId || `name:${l.nameHi}`;

export function buildReport(input: ReportInput): ProfitReport {
  const { from, to, sales, corrections, saleById, products } = input;
  const m = marginTotals(sales, corrections, saleById);
  const productById = new Map(products.map((p) => [p.id, p]));
  const byId = new Map(sales.map((s) => [s.id, s]));

  // Per item: known lines -> items, unknown lines -> missing.
  const items = new Map<string, ItemRow>();
  const missing = new Map<string, MissingRow>();
  const addLine = (l: Pick<SaleItem, "productId" | "nameHi" | "nameEn" | "unit" | "price" | "amount" | "discount">, qty: number, cost: CostLine & Partial<SaleItem>, soldAt: number) => {
    const key = keyOf(l);
    // Amount-based lines ("₹20 का सामान") are worth exactly what was paid (returns: their pro-rata part).
    const value = Math.sign(qty) * lineTotal({ ...l, qty: Math.abs(qty) });
    if (!costKnown(cost)) {
      const p = productById.get(l.productId);
      const row = missing.get(key) ?? { key, productId: l.productId, nameHi: l.nameHi, nameEn: l.nameEn, unit: l.unit, qty: 0, sales: 0, exists: !!p, buyPriceNow: p?.buyPrice ?? 0 };
      row.qty += qty;
      row.sales += value;
      missing.set(key, row);
      return;
    }
    const row = items.get(key) ?? { key, productId: l.productId, nameHi: l.nameHi, nameEn: l.nameEn, unit: l.unit, qty: 0, sales: 0, cost: 0, margin: 0, pct: null, flags: [] };
    row.qty += qty;
    row.sales += value;
    row.cost += qty * cost.cost;
    if (qty > 0) {
      const f = costFlag({ price: value / qty, cost: cost.cost, costKnown: true, costAt: cost.costAt, costFilled: cost.costFilled }, soldAt);
      if (f && f !== "missing" && !row.flags.includes(f)) row.flags.push(f);
    }
    items.set(key, row);
  };
  for (const s of sales) for (const it of s.items) addLine(it, it.qty, it, s.createdAt);
  for (const c of corrections) {
    const sale = byId.get(c.saleId) ?? saleById.get(c.saleId);
    for (const l of c.lines) addLine(l, -l.qty, resolveLine(l, sale), c.createdAt);
  }
  const itemRows = [...items.values()]
    .map((r) => {
      const sales = round2(r.sales);
      const cost = round2(r.cost);
      const margin = round2(sales - cost);
      return { ...r, qty: round2(r.qty), sales, cost, margin, pct: sales > EPS ? Math.round((margin / sales) * 1000) / 10 : null };
    })
    .filter((r) => Math.abs(r.qty) > 1e-9 || Math.abs(r.sales) > EPS);
  const missingRows = [...missing.values()]
    .map((r) => ({ ...r, qty: round2(r.qty), sales: round2(r.sales) }))
    .filter((r) => r.qty > 1e-9 && r.sales > EPS)
    .sort((a, b) => b.sales - a.sales);

  // Money side.
  const split = moneySplit(sales, corrections);
  const collected = round2(split.cash + split.upi);
  const marginOnCredit = m.netSales > EPS && split.credit > EPS ? round2((m.margin * split.credit) / m.netSales) : 0;
  const udhaarReceived = round2(input.ledger.filter((e) => e.type === "credit" && e.kind !== "return").reduce((a, e) => a + e.amount, 0));

  // Drawer: expenses by category; money out that is not an expense.
  // Entries in force: not a void and not voided (same rule as the drawer screen).
  const inRange = input.cash.filter((e) => e.day >= from && e.day <= to);
  const voided = new Set(inRange.filter((e) => e.kind === "void" && e.voidsId).map((e) => e.voidsId as string));
  const live = inRange.filter((e) => e.kind !== "void" && !voided.has(e.id));
  const byCategory: Partial<Record<ExpenseCategory, number>> = {};
  let expenseTotal = 0;
  let expenseCount = 0;
  const notExpenses = { withdrawal: 0, supplier: 0, bank: 0 };
  for (const e of live) {
    if (e.kind === "expense") {
      const c = e.category ?? "other";
      byCategory[c] = round2((byCategory[c] ?? 0) + e.amount);
      expenseTotal += e.amount;
      expenseCount++;
    } else if (e.kind === "withdrawal" || e.kind === "supplier" || e.kind === "bank") notExpenses[e.kind] = round2(notExpenses[e.kind] + e.amount);
  }

  // Stock losses (damage / theft) valued at cost.
  const lossRows: LossRow[] = [];
  for (const mv of input.moves) {
    if (mv.reason !== "damage" && mv.reason !== "theft") continue;
    const day = dayKey(mv.createdAt);
    if (day < from || day > to || mv.delta >= 0) continue;
    const p = productById.get(mv.productId);
    const qty = round2(-mv.delta);
    const unit = mv.unitCost && mv.unitCost > 0 ? mv.unitCost : p && p.buyPrice > 0 ? p.buyPrice : null;
    lossRows.push({
      id: mv.id,
      productId: mv.productId,
      nameHi: p?.nameHi ?? "—",
      nameEn: p?.nameEn ?? "—",
      unit: p?.unit ?? "pcs",
      reason: mv.reason,
      qty,
      value: unit === null ? null : round2(qty * unit),
      estimated: !(mv.unitCost && mv.unitCost > 0) && unit !== null,
      createdAt: mv.createdAt,
    });
  }
  lossRows.sort((a, b) => b.createdAt - a.createdAt);
  const lossTotal = round2(lossRows.reduce((a, r) => a + (r.value ?? 0), 0));
  const expenses = round2(expenseTotal);

  return {
    ...m,
    from,
    to,
    billCount: sales.filter((s) => (s.status ?? "active") !== "cancelled").length,
    grossSales: round2(sales.reduce((a, s) => a + s.total, 0)),
    returns: round2(corrections.reduce((a, c) => a + c.amount, 0)),
    collected,
    cash: split.cash,
    upi: split.upi,
    upiPending: split.upiPending,
    onCredit: split.credit,
    marginOnCredit,
    udhaarReceived,
    expenses: { total: expenses, byCategory, count: expenseCount },
    losses: { total: lossTotal, rows: lossRows, unvalued: lossRows.filter((r) => r.value === null).length },
    netEarned: round2(m.margin - expenses - lossTotal),
    notExpenses,
    items: itemRows,
    missing: missingRows,
  };
}

/** Best earners first (by rupees of margin). */
export const topItems = (r: ProfitReport, n = 5) => [...r.items].filter((i) => i.sales > EPS && i.margin > EPS).sort((a, b) => b.margin - a.margin).slice(0, n);

/** Sold at a loss, or under LOW_MARGIN_PCT of the selling price (worst first). */
export const lowMarginItems = (r: ProfitReport) =>
  r.items.filter((i) => i.pct !== null && i.pct < LOW_MARGIN_PCT).sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));

/** Items whose buy price needs a look (above selling price / old / filled in later). */
export const costChecks = (r: ProfitReport) => r.items.filter((i) => i.flags.length > 0);
