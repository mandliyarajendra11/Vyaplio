import type { useTranslations } from "next-intl";
import { addDays, format, parseISO } from "date-fns";
import { v4 as uuid } from "uuid";
import {
  db,
  shopTables,
  type CashEntry,
  type Locale,
  type OrderLine,
  type Product,
  type Purchase,
  type PurchaseLine,
  type PurchaseOrder,
  type Shop,
  type StockMove,
  type Supplier,
  type SupplierEntry,
} from "./db";
import { loadCashDay } from "./cash";
import { dayKey, fmtDate } from "./dates";
import { formatINR, formatNum, round2 } from "./money";
import { names } from "./names";
import { enqueue } from "./ops";
import { kindOf, validQtyFor } from "./units";
import { normName, planSuppliers, supplierIdFor } from "./supplierMigrate";

export { normName, supplierIdFor };

/*
 * Supplier payment diary: suppliers, purchase bills, an append-only supplier ledger and WhatsApp
 * orders. What we owe a supplier is never stored: it is always the sum of the ledger.
 */

type T = ReturnType<typeof useTranslations>;
const EPS = 0.005;
/** "Due soon" = within this many days (Home chip + alerts). */
export const DUE_SOON_DAYS = 3;

export class SupplierError extends Error {
  constructor(public code: "name" | "duplicate" | "notFound" | "lines" | "qty" | "price" | "paid" | "amount" | "reason" | "future" | "terms" | "status" | "expiry") {
    super(code);
  }
}

/* ------------------------------ matching ------------------------------ */

/** A product's supplier record: the link, else the free-text name (older rows / other phones). */
export function supplierOf(p: Pick<Product, "supplierId" | "supplier">, suppliers: Supplier[]): Supplier | undefined {
  if (p.supplierId) {
    const s = suppliers.find((x) => x.id === p.supplierId);
    if (s) return s;
  }
  const n = p.supplier ? normName(p.supplier) : "";
  return n ? suppliers.find((x) => normName(x.name) === n) : undefined;
}

/** Galla supplier payments that belong to this supplier (by id or by the typed name). */
export function gallaPaymentsOf(s: Supplier, entries: CashEntry[]) {
  const n = normName(s.name);
  const voided = new Set(entries.filter((e) => e.kind === "void").map((e) => e.voidsId));
  return entries.filter((e) => e.kind === "supplier" && !voided.has(e.id) && (e.supplierId === s.id || (!!e.supplierName && normName(e.supplierName) === n)));
}

/* ------------------------------ balance + dues (pure) ------------------------------ */

/** + = we owe more, − = we owe less. */
export const entryEffect = (e: Pick<SupplierEntry, "type" | "amount">) => (e.type === "purchase" || e.type === "adjust" ? e.amount : -e.amount);

export const outstandingOf = (entries: Pick<SupplierEntry, "type" | "amount">[]) => round2(entries.reduce((a, e) => a + entryEffect(e), 0));

export type DueState = "overdue" | "today" | "soon" | "later" | "none";

export function dueState(dueDate: string | undefined, today: string, soonDays = DUE_SOON_DAYS): DueState {
  if (!dueDate) return "none";
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return dueDate <= addDaysKey(today, soonDays) ? "soon" : "later";
}

export const addDaysKey = (day: string, days: number) => format(addDays(parseISO(day), days), "yyyy-MM-dd");
export const daysBetween = (from: string, to: string) => Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000);

export interface OpenBill {
  entryId: string;
  purchaseId?: string;
  billNo?: string;
  day: string;
  amount: number;
  left: number;
  dueDate?: string;
  state: DueState;
}

export interface SupplierStatus {
  outstanding: number;
  /** Bills (and + adjustments) still unpaid, oldest first. */
  open: OpenBill[];
  overdue: number;
  /** Due today or within DUE_SOON_DAYS. */
  dueSoon: number;
  /** Earliest unpaid due date. */
  nextDue?: string;
  /** Worst state among unpaid bills. */
  state: DueState;
  lastPurchase?: string;
  lastPayment?: string;
}

const ORDER: DueState[] = ["overdue", "today", "soon", "later", "none"];

/**
 * Which bills are still unpaid: payments / returns made against a bill settle that bill first,
 * the rest settles the oldest bills first (FIFO). A − adjustment counts like a payment.
 */
export function supplierStatus(entries: SupplierEntry[], today: string): SupplierStatus {
  const sorted = entries.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.createdAt - b.createdAt));
  const debts: OpenBill[] = sorted
    .filter((e) => entryEffect(e) > 0)
    .map((e) => ({ entryId: e.id, purchaseId: e.purchaseId, billNo: e.billNo, day: e.day, amount: e.amount, left: e.amount, dueDate: e.type === "purchase" ? e.dueDate : undefined, state: "none" as DueState }));
  let pool = 0;
  for (const e of sorted) {
    const eff = entryEffect(e);
    if (eff >= 0) continue;
    let amt = -eff;
    if (e.purchaseId) {
      const d = debts.find((x) => x.purchaseId === e.purchaseId);
      if (d) {
        const use = Math.min(d.left, amt);
        d.left = round2(d.left - use);
        amt = round2(amt - use);
      }
    }
    pool = round2(pool + amt);
  }
  // FIFO by due date (no due date = by bill date).
  for (const d of debts.slice().sort((a, b) => ((a.dueDate ?? a.day) < (b.dueDate ?? b.day) ? -1 : (a.dueDate ?? a.day) > (b.dueDate ?? b.day) ? 1 : 0))) {
    if (pool <= EPS) break;
    const use = Math.min(d.left, pool);
    d.left = round2(d.left - use);
    pool = round2(pool - use);
  }
  const open = debts.filter((d) => d.left > EPS).map((d) => ({ ...d, state: dueState(d.dueDate, today) }));
  const overdue = round2(open.filter((d) => d.state === "overdue").reduce((a, d) => a + d.left, 0));
  const dueSoon = round2(open.filter((d) => d.state === "today" || d.state === "soon").reduce((a, d) => a + d.left, 0));
  const nextDue = open.map((d) => d.dueDate).filter((x): x is string => !!x).sort()[0];
  const state = open.reduce<DueState>((w, d) => (ORDER.indexOf(d.state) < ORDER.indexOf(w) ? d.state : w), "none");
  const last = (type: SupplierEntry["type"]) => sorted.filter((e) => e.type === type).pop()?.day;
  return { outstanding: outstandingOf(entries), open, overdue, dueSoon, nextDue, state: open.length ? state : "none", lastPurchase: last("purchase"), lastPayment: last("payment") };
}

export interface SupplierDue {
  supplier: Supplier;
  status: SupplierStatus;
}

/** Suppliers with something overdue or due soon (most urgent first). */
export function supplierDues(suppliers: Supplier[], entries: SupplierEntry[], today: string): SupplierDue[] {
  const by = new Map<string, SupplierEntry[]>();
  for (const e of entries) by.set(e.supplierId, [...(by.get(e.supplierId) ?? []), e]);
  return suppliers
    .map((supplier) => ({ supplier, status: supplierStatus(by.get(supplier.id) ?? [], today) }))
    .filter((d) => d.status.overdue > EPS || d.status.dueSoon > EPS)
    .sort((a, b) => ORDER.indexOf(a.status.state) - ORDER.indexOf(b.status.state) || (a.status.nextDue ?? "").localeCompare(b.status.nextDue ?? ""));
}

/* ------------------------------ ordering (pure) ------------------------------ */

/**
 * Ordering step: suppliers sell whole units – whole kg / L for loose goods (bags, tins), whole pieces /
 * packets / boxes for packs. (The product's own sale step, e.g. 250 g, is for the counter only.)
 */
const ORDER_STEP = 1;
/** Order up to: the product's own target, else twice the low-stock level (at least one step). */
export const reorderTarget = (p: Pick<Product, "reorderTo" | "lowStockAt" | "unit">) =>
  p.reorderTo && p.reorderTo > 0 ? p.reorderTo : Math.max(ORDER_STEP, round2(p.lowStockAt * 2));

/** Suggested order = target − stock now (stock below zero counts as 0), rounded up to the unit's step. */
export function suggestQty(p: Pick<Product, "reorderTo" | "lowStockAt" | "unit" | "qty">) {
  const step = ORDER_STEP;
  const need = reorderTarget(p) - Math.max(0, p.qty);
  return need <= 0 ? step : round2(Math.ceil(need / step - 1e-9) * step);
}

/** Low / short products grouped by supplier ("" = no supplier yet). */
export function orderGroups(products: Product[], suppliers: Supplier[]) {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const id = supplierOf(p, suppliers)?.id ?? "";
    groups.set(id, [...(groups.get(id) ?? []), p]);
  }
  return groups;
}

export function orderText(t: T, lines: OrderLine[], shop: Shop, supplier: Supplier, locale: Locale) {
  return [
    t("suppliers.orderHello", { name: supplier.name, shop: shop.name }),
    "",
    ...lines.map((l, i) => t("suppliers.orderLine", { n: i + 1, name: names(l, locale).primary, qty: formatNum(l.qty), unit: t(`unit.${l.unit}`) })),
    "",
    t("suppliers.orderThanks", { owner: shop.ownerName || shop.name }),
  ].join("\n");
}

/* ------------------------------ writes ------------------------------ */

const clean = (v?: string, max = 200) => v?.trim().replace(/\s+/g, " ").slice(0, max) || undefined;

async function putEntry(e: SupplierEntry) {
  await db.supplierLedger.add(e);
  await enqueue("supplier_ledger", "upsert", e.id, e);
  return e;
}

/** Cash leaves the galla today as a supplier payment (not an expense). A closed day gets a logged reason. */
async function gallaOut(opts: { id: string; shopId: string; supplier: Supplier; amount: number; note?: string; byName?: string; closedReason?: string; at: number }) {
  const day = dayKey(opts.at);
  const closed = (await loadCashDay(opts.shopId, day)).closed;
  const entry: CashEntry = {
    id: opts.id,
    shopId: opts.shopId,
    day,
    kind: "supplier",
    amount: round2(opts.amount),
    supplierId: opts.supplier.id,
    supplierName: opts.supplier.name.slice(0, 80),
    createdAt: opts.at,
  };
  if (opts.note) entry.note = opts.note.slice(0, 200);
  if (closed) {
    entry.afterClose = true;
    entry.reason = opts.closedReason || "supplier diary";
  }
  if (opts.byName) entry.byName = opts.byName;
  await db.cashEntries.add(entry);
  await enqueue("cash_entries", "upsert", entry.id, entry);
  return entry;
}

export interface SupplierInput {
  name: string;
  phone?: string;
  items?: string;
  termsDays?: number | null;
  notes?: string;
}

/** Add or edit a supplier. New suppliers get a name-based id (the same on every phone). */
export async function saveSupplier(shopId: string, input: SupplierInput, id?: string) {
  const name = clean(input.name, 80);
  if (!name) throw new SupplierError("name");
  const terms = input.termsDays === null || input.termsDays === undefined || Number.isNaN(input.termsDays) ? undefined : Math.round(input.termsDays);
  if (terms !== undefined && (terms < 0 || terms > 365)) throw new SupplierError("terms");
  const phone = input.phone?.replace(/[^\d+]/g, "").slice(0, 15) || undefined;
  return db.transaction("rw", shopTables(), async () => {
    const all = await db.suppliers.where("shopId").equals(shopId).toArray();
    if (all.some((s) => s.id !== id && normName(s.name) === normName(name))) throw new SupplierError("duplicate");
    const cur = id ? all.find((s) => s.id === id) : undefined;
    if (id && !cur) throw new SupplierError("notFound");
    const now = Date.now();
    let sid = cur?.id ?? supplierIdFor(shopId, name);
    if (!cur && (await db.suppliers.get(sid))) sid = uuid(); // a renamed supplier holds the name-based id
    const next: Supplier = { ...(cur ?? { id: sid, shopId, createdAt: now }), name, updatedAt: now };
    for (const [k, v] of [
      ["phone", phone],
      ["items", clean(input.items)],
      ["termsDays", terms],
      ["notes", clean(input.notes, 300)],
    ] as const) {
      if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
      else (next as unknown as Record<string, unknown>)[k] = v;
    }
    await db.suppliers.put(next);
    await enqueue("suppliers", "upsert", next.id, next);
    return next;
  });
}

/**
 * Create supplier records for free-text names that have none yet (after a cloud pull or a restore
 * of an older backup). Products are linked locally. Returns how many suppliers were created.
 */
export async function ensureSupplierRecords(shopId: string) {
  return db.transaction("rw", shopTables(), async () => {
    const [products, cash, existing] = await Promise.all([
      db.products.where("shopId").equals(shopId).toArray(),
      db.cashEntries.where("shopId").equals(shopId).filter((e) => e.kind === "supplier").toArray(),
      db.suppliers.where("shopId").equals(shopId).toArray(),
    ]);
    const plan = planSuppliers(products, cash, existing, Date.now());
    for (const s of plan.created) {
      await db.suppliers.put(s);
      await enqueue("suppliers", "upsert", s.id, s);
    }
    for (const [pid, sid] of plan.links) await db.products.update(pid, { supplierId: sid });
    return plan.created.length;
  });
}

export interface PurchaseLineInput {
  productId: string;
  qty: number;
  buyPrice: number;
  /** Packed only (optional): this batch's expiry date (yyyy-MM-dd). */
  expiryDate?: string;
}

export interface PurchaseInput {
  /** Fixed by the form so a double tap / retry records the bill once. */
  id?: string;
  shopId: string;
  supplierId: string;
  day: string;
  billNo?: string;
  lines: PurchaseLineInput[];
  paidCash: number;
  paidUpi: number;
  orderId?: string;
  note?: string;
  byName?: string;
  /** Reason written on the galla entry when today's galla is already closed. */
  closedReason?: string;
}

export const purchaseTotal = (lines: Pick<PurchaseLineInput, "qty" | "buyPrice">[]) => round2(lines.reduce((a, l) => a + round2(l.qty * l.buyPrice), 0));

/**
 * Record a supplier's bill:
 *  - stock goes up through stock moves ("purchase", refId = bill; ids derived from the bill so a
 *    retry or a second sync never adds stock twice)
 *  - each product's buy price becomes the bill's price (date recorded; feeds the profit report)
 *  - the ledger gets the bill total, and the cash / UPI paid now as payments
 *  - cash paid now leaves the galla as a supplier payment (not an expense)
 */
export async function recordPurchase(input: PurchaseInput) {
  const now = Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || input.day > dayKey(now)) throw new SupplierError("future");
  const lines = input.lines.filter((l) => l.qty !== 0);
  if (!lines.length) throw new SupplierError("lines");
  for (const l of lines) {
    // Whole packs for packed goods, 10 g / 10 ml steps for loose (checked against the product below).
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw new SupplierError("qty");
    if (l.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(l.expiryDate)) throw new SupplierError("expiry");
    if (!Number.isFinite(l.buyPrice) || l.buyPrice <= 0) throw new SupplierError("price");
  }
  const total = purchaseTotal(lines);
  const paidCash = round2(input.paidCash || 0);
  const paidUpi = round2(input.paidUpi || 0);
  if (paidCash < 0 || paidUpi < 0 || !Number.isFinite(paidCash + paidUpi) || paidCash + paidUpi > total + EPS) throw new SupplierError("paid");
  const credit = round2(total - paidCash - paidUpi);
  const id = input.id ?? uuid();

  return db.transaction("rw", shopTables(), async () => {
    const done = await db.purchases.get(id);
    if (done) return done; // already recorded (double tap / retry)
    const supplier = await db.suppliers.get(input.supplierId);
    if (!supplier || supplier.shopId !== input.shopId) throw new SupplierError("notFound");
    const billNo = clean(input.billNo, 40);
    const out: PurchaseLine[] = [];
    for (const [i, l] of lines.entries()) {
      const p = await db.products.get(l.productId);
      if (!p || p.shopId !== input.shopId) throw new SupplierError("notFound");
      // Never silently round: 2.255 kg or 1.5 packets is refused, not stored as something else.
      if (!validQtyFor(l.qty, p.unit)) throw new SupplierError("qty");
      const qty = round2(l.qty);
      const price = round2(l.buyPrice);
      const line: PurchaseLine = { productId: p.id, nameHi: p.nameHi, nameEn: p.nameEn, unit: p.unit, qty, buyPrice: price };
      const next: Product = { ...p, qty: round2(p.qty + qty) };
      // Expiry per batch (packs only). The product keeps one date: this batch's when the shelf was empty,
      // otherwise the earlier of the two (the older stock is sold first).
      if (l.expiryDate && kindOf(p) === "packed") {
        line.expiryDate = l.expiryDate;
        const exp = p.qty <= 0 || !p.expiryDate ? l.expiryDate : p.expiryDate < l.expiryDate ? p.expiryDate : l.expiryDate;
        if (exp !== p.expiryDate) {
          next.expiryDate = exp;
          next.updatedAt = now;
        }
      }
      if (p.buyPrice !== price) {
        if (p.buyPrice > 0) line.prevBuyPrice = p.buyPrice;
        next.buyPrice = price;
        next.buyPriceAt = now;
        next.updatedAt = now;
      }
      if (!p.supplierId && !p.supplier?.trim()) {
        next.supplierId = supplier.id;
        next.supplier = supplier.name;
        next.updatedAt = now;
      }
      await db.products.put(next);
      await enqueue("products", "upsert", p.id, next);
      const move: StockMove = { id: `pur-${id}-${i}`, shopId: input.shopId, productId: p.id, delta: qty, reason: "purchase", refId: id, createdAt: now };
      if (billNo) move.note = billNo;
      await db.stockMoves.add(move);
      await enqueue("stock_moves", "upsert", move.id, move);
      out.push(line);
    }
    const dueDate = credit > EPS && supplier.termsDays !== undefined ? addDaysKey(input.day, supplier.termsDays) : undefined;
    const purchase: Purchase = { id, shopId: input.shopId, supplierId: supplier.id, day: input.day, lines: out, total, paidCash, paidUpi, credit, createdAt: now };
    if (billNo) purchase.billNo = billNo;
    if (dueDate) purchase.dueDate = dueDate;
    if (input.orderId) purchase.orderId = input.orderId;
    const note = clean(input.note);
    if (note) purchase.note = note;
    if (input.byName) purchase.byName = input.byName;
    await db.purchases.add(purchase);
    await enqueue("purchases", "upsert", id, purchase);

    const base = { shopId: input.shopId, supplierId: supplier.id, purchaseId: id, createdAt: now, ...(input.byName ? { byName: input.byName } : {}), ...(billNo ? { billNo } : {}) };
    const bill: SupplierEntry = { ...base, id: `${id}-bill`, type: "purchase", amount: total, day: input.day };
    if (dueDate) bill.dueDate = dueDate;
    await putEntry(bill);
    if (paidCash > 0) {
      const g = await gallaOut({ id: `${id}-galla`, shopId: input.shopId, supplier, amount: paidCash, note: billNo ? `#${billNo}` : undefined, byName: input.byName, closedReason: input.closedReason, at: now });
      await putEntry({ ...base, id: `${id}-cash`, type: "payment", amount: paidCash, method: "cash", day: dayKey(now), cashEntryId: g.id });
    }
    if (paidUpi > 0) await putEntry({ ...base, id: `${id}-upi`, type: "payment", amount: paidUpi, method: "upi", day: dayKey(now) });

    if (input.orderId) {
      const o = await db.orders.get(input.orderId);
      if (o && o.status === "ordered") {
        const next: PurchaseOrder = { ...o, status: "received", purchaseId: id, updatedAt: now };
        await db.orders.put(next);
        await enqueue("purchase_orders", "upsert", o.id, next);
      }
    }
    return purchase;
  });
}

/** Pay a supplier later. Cash leaves the galla (supplier payment); UPI is recorded only in the diary. */
export async function paySupplier(opts: { id?: string; shopId: string; supplierId: string; amount: number; method: "cash" | "upi"; purchaseId?: string; note?: string; byName?: string; closedReason?: string }) {
  const amount = round2(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new SupplierError("amount");
  const id = opts.id ?? uuid();
  return db.transaction("rw", shopTables(), async () => {
    const done = await db.supplierLedger.get(id);
    if (done) return done;
    const supplier = await db.suppliers.get(opts.supplierId);
    if (!supplier || supplier.shopId !== opts.shopId) throw new SupplierError("notFound");
    const now = Date.now();
    const note = clean(opts.note);
    const e: SupplierEntry = { id, shopId: opts.shopId, supplierId: supplier.id, type: "payment", amount, method: opts.method, day: dayKey(now), createdAt: now };
    if (opts.purchaseId) e.purchaseId = opts.purchaseId;
    if (note) e.note = note;
    if (opts.byName) e.byName = opts.byName;
    if (opts.method === "cash") e.cashEntryId = (await gallaOut({ id: `${id}-galla`, shopId: opts.shopId, supplier, amount, note, byName: opts.byName, closedReason: opts.closedReason, at: now })).id;
    return putEntry(e);
  });
}

/**
 * Goods sent back / debit note: we owe less. Lines (optional) take the goods out of stock
 * ("supplierReturn" moves); the amount defaults to their value at the given price.
 */
export async function returnToSupplier(opts: { id?: string; shopId: string; supplierId: string; lines?: PurchaseLineInput[]; amount?: number; reason: string; byName?: string }) {
  const reason = clean(opts.reason);
  if (!reason) throw new SupplierError("reason");
  const lines = (opts.lines ?? []).filter((l) => l.qty > 0);
  for (const l of lines) if (!Number.isFinite(l.qty) || !Number.isFinite(l.buyPrice) || l.buyPrice < 0) throw new SupplierError("qty");
  const amount = round2(opts.amount ?? purchaseTotal(lines));
  if (!Number.isFinite(amount) || amount <= 0) throw new SupplierError("amount");
  const id = opts.id ?? uuid();
  return db.transaction("rw", shopTables(), async () => {
    if (await db.supplierLedger.get(id)) return (await db.supplierLedger.get(id))!;
    const supplier = await db.suppliers.get(opts.supplierId);
    if (!supplier || supplier.shopId !== opts.shopId) throw new SupplierError("notFound");
    const now = Date.now();
    const what: string[] = [];
    for (const [i, l] of lines.entries()) {
      const p = await db.products.get(l.productId);
      if (!p || p.shopId !== opts.shopId) throw new SupplierError("notFound");
      const qty = round2(l.qty);
      const next = { ...p, qty: round2(p.qty - qty) };
      await db.products.put(next);
      await enqueue("products", "upsert", p.id, next);
      const move: StockMove = { id: `ret-${id}-${i}`, shopId: opts.shopId, productId: p.id, delta: -qty, reason: "supplierReturn", refId: id, note: reason.slice(0, 200), createdAt: now };
      if (l.buyPrice > 0) move.unitCost = round2(l.buyPrice);
      await db.stockMoves.add(move);
      await enqueue("stock_moves", "upsert", move.id, move);
      what.push(`${p.nameHi || p.nameEn} ×${formatNum(qty)}`);
    }
    const e: SupplierEntry = { id, shopId: opts.shopId, supplierId: supplier.id, type: "return", amount, reason, day: dayKey(now), createdAt: now };
    if (what.length) e.note = what.join(", ").slice(0, 200);
    if (opts.byName) e.byName = opts.byName;
    return putEntry(e);
  });
}

/** A signed correction (+ we owe more, − we owe less), always with a reason. */
export async function adjustSupplier(opts: { id?: string; shopId: string; supplierId: string; amount: number; reason: string; byName?: string }) {
  const reason = clean(opts.reason);
  if (!reason) throw new SupplierError("reason");
  const amount = round2(opts.amount);
  if (!Number.isFinite(amount) || amount === 0) throw new SupplierError("amount");
  const id = opts.id ?? uuid();
  return db.transaction("rw", shopTables(), async () => {
    if (await db.supplierLedger.get(id)) return (await db.supplierLedger.get(id))!;
    const supplier = await db.suppliers.get(opts.supplierId);
    if (!supplier || supplier.shopId !== opts.shopId) throw new SupplierError("notFound");
    const now = Date.now();
    const e: SupplierEntry = { id, shopId: opts.shopId, supplierId: supplier.id, type: "adjust", amount, reason, day: dayKey(now), createdAt: now };
    if (opts.byName) e.byName = opts.byName;
    return putEntry(e);
  });
}

/** Remember the supplier for products (from the order screen's "no supplier yet" group). */
export async function linkProducts(productIds: string[], supplierId: string) {
  return db.transaction("rw", shopTables(), async () => {
    const s = await db.suppliers.get(supplierId);
    if (!s) throw new SupplierError("notFound");
    const now = Date.now();
    for (const id of productIds) {
      const p = await db.products.get(id);
      if (!p || p.shopId !== s.shopId || p.supplierId === s.id) continue;
      const next: Product = { ...p, supplierId: s.id, supplier: s.name, updatedAt: now };
      await db.products.put(next);
      await enqueue("products", "upsert", p.id, next);
    }
  });
}

/** Save a WhatsApp order as "ordered" (the app only opens WhatsApp; the shopkeeper presses send). */
export async function createOrder(opts: { id?: string; shopId: string; supplierId: string; lines: { productId: string; qty: number }[]; byName?: string }) {
  const lines = opts.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new SupplierError("lines");
  for (const l of lines) if (!Number.isFinite(l.qty)) throw new SupplierError("qty");
  const id = opts.id ?? uuid();
  return db.transaction("rw", shopTables(), async () => {
    const done = await db.orders.get(id);
    if (done) return done;
    const supplier = await db.suppliers.get(opts.supplierId);
    if (!supplier || supplier.shopId !== opts.shopId) throw new SupplierError("notFound");
    const out: OrderLine[] = [];
    for (const l of lines) {
      const p = await db.products.get(l.productId);
      if (!p || p.shopId !== opts.shopId) throw new SupplierError("notFound");
      out.push({ productId: p.id, nameHi: p.nameHi, nameEn: p.nameEn, unit: p.unit, qty: round2(l.qty) });
    }
    const now = Date.now();
    const order: PurchaseOrder = { id, shopId: opts.shopId, supplierId: supplier.id, lines: out, status: "ordered", createdAt: now, updatedAt: now };
    if (opts.byName) order.byName = opts.byName;
    await db.orders.put(order);
    await enqueue("purchase_orders", "upsert", id, order);
    return order;
  });
}

export async function cancelOrder(id: string) {
  return db.transaction("rw", shopTables(), async () => {
    const o = await db.orders.get(id);
    if (!o) throw new SupplierError("notFound");
    if (o.status !== "ordered") throw new SupplierError("status");
    const next: PurchaseOrder = { ...o, status: "cancelled", updatedAt: Date.now() };
    await db.orders.put(next);
    await enqueue("purchase_orders", "upsert", id, next);
    return next;
  });
}

/* ------------------------------ reading ------------------------------ */

export interface SupplierRow {
  supplier: Supplier;
  status: SupplierStatus;
  products: number;
  openOrders: number;
}

export async function loadSupplierRows(shopId: string, today: string): Promise<SupplierRow[]> {
  const [suppliers, entries, products, orders] = await Promise.all([
    db.suppliers.where("shopId").equals(shopId).toArray(),
    db.supplierLedger.where("shopId").equals(shopId).toArray(),
    db.products.where("shopId").equals(shopId).toArray(),
    db.orders.where("shopId").equals(shopId).filter((o) => o.status === "ordered").toArray(),
  ]);
  const by = new Map<string, SupplierEntry[]>();
  for (const e of entries) by.set(e.supplierId, [...(by.get(e.supplierId) ?? []), e]);
  const count = new Map<string, number>();
  for (const p of products) {
    const s = supplierOf(p, suppliers);
    if (s) count.set(s.id, (count.get(s.id) ?? 0) + 1);
  }
  return suppliers
    .map((supplier) => ({
      supplier,
      status: supplierStatus(by.get(supplier.id) ?? [], today),
      products: count.get(supplier.id) ?? 0,
      openOrders: orders.filter((o) => o.supplierId === supplier.id).length,
    }))
    .sort((a, b) => ORDER.indexOf(a.status.state) - ORDER.indexOf(b.status.state) || b.status.outstanding - a.status.outstanding || a.supplier.name.localeCompare(b.supplier.name));
}

export async function loadSupplierDues(shopId: string, today: string) {
  const [suppliers, entries] = await Promise.all([db.suppliers.where("shopId").equals(shopId).toArray(), db.supplierLedger.where("shopId").equals(shopId).toArray()]);
  return supplierDues(suppliers, entries, today);
}

/* ------------------------------ CSV ------------------------------ */

export const SUPPLIERS_CSV_HEADERS = ["name", "phone", "items", "terms_days", "notes", "outstanding", "overdue", "next_due"];
export function suppliersCSVRows(rows: SupplierRow[]) {
  return rows.map((r) => [r.supplier.name, r.supplier.phone, r.supplier.items, r.supplier.termsDays, r.supplier.notes, r.status.outstanding, r.status.overdue, r.status.nextDue]);
}

export const PURCHASES_CSV_HEADERS = ["date", "bill_no", "supplier", "items", "total", "paid_cash", "paid_upi", "on_credit", "due_date", "order_id", "by"];
export function purchasesCSVRows(purchases: Purchase[], suppliers: Supplier[]) {
  const name = new Map(suppliers.map((s) => [s.id, s.name]));
  return purchases
    .slice()
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.createdAt - b.createdAt))
    .map((p) => [
      p.day,
      p.billNo,
      name.get(p.supplierId) ?? p.supplierId,
      p.lines.map((l) => `${l.nameEn || l.nameHi} ${l.qty} ${l.unit} @ ${l.buyPrice}`).join("; "),
      p.total,
      p.paidCash,
      p.paidUpi,
      p.credit,
      p.dueDate,
      p.orderId,
      p.byName,
    ]);
}

export const SUPPLIER_LEDGER_CSV_HEADERS = ["date", "time", "supplier", "type", "amount", "effect", "balance_after", "method", "bill_no", "due_date", "reason", "note", "by"];
export function supplierLedgerCSVRows(entries: SupplierEntry[], suppliers: Supplier[]) {
  const name = new Map(suppliers.map((s) => [s.id, s.name]));
  const bal = new Map<string, number>();
  return entries
    .slice()
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.createdAt - b.createdAt))
    .map((e) => {
      const after = round2((bal.get(e.supplierId) ?? 0) + entryEffect(e));
      bal.set(e.supplierId, after);
      return [e.day, fmtDate(e.createdAt, "en", "HH:mm"), name.get(e.supplierId) ?? e.supplierId, e.type, e.amount, entryEffect(e), after, e.method, e.billNo, e.dueDate, e.reason, e.note, e.byName];
    });
}

/** "₹1,200 बाकी · 3 दिन लेट" style status line. `t` = root translator. */
export function dueText(t: T, st: SupplierStatus, today: string) {
  if (st.outstanding <= EPS) return st.outstanding < -EPS ? t("suppliers.advance", { amount: formatINR(-st.outstanding) }) : t("suppliers.settled");
  const owe = t("suppliers.owe", { amount: formatINR(st.outstanding) });
  if (st.state === "overdue" && st.nextDue) return `${owe} · ${t("suppliers.lateBy", { days: daysBetween(st.nextDue, today) })}`;
  if (st.state === "today") return `${owe} · ${t("suppliers.dueToday")}`;
  if ((st.state === "soon" || st.state === "later") && st.nextDue) return `${owe} · ${t("suppliers.dueIn", { days: daysBetween(today, st.nextDue) })}`;
  return owe;
}
