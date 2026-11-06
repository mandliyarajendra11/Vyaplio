import { v4 as uuid } from "uuid";
import {
  db,
  shopTables,
  type Supplier,
  type Customer,
  type LedgerEntry,
  type OutboxItem,
  type PaymentType,
  type CorrectionLine,
  type Product,
  type RefundMethod,
  type Sale,
  type SaleCorrection,
  type SaleItem,
  type Shop,
  type StockMove,
  type Unit,
  ADJUST_REASONS,
  type AdjustReason,
} from "./db";
import { dayKey } from "./dates";
import { allocateDiscount, discountAmount, roundSaleItems, type BillDiscount } from "./discounts";
import { round2 } from "./money";
import { isLoose, kindForUnit, kindOf, lineTotal, partValue, qtyForAmount, unitsFor, validAmount, validQtyFor, validStep, type ProductKind } from "./units";
import { costKnown, costSnapshot } from "./profit";
import { normName, supplierIdFor } from "./supplierMigrate";
import { PaymentError, buildPayments, crossAmount, partSum, paymentKind, paymentsOf, planRefund, refundChoices, type PaymentRequest } from "./payments";

/**
 * Generic step for quantity steppers that only know the unit (returns on a bill): 100 g / 100 ml for
 * loose goods, 1 for packs. Selling and the stock screen use the product's own step (units.ts stepOf).
 */
export const stepFor = (unit: Unit) => (isLoose(unit) ? 0.1 : 1);

/** Record a change for cloud sync (offline queue). Kept until the server confirms the row. */
export async function enqueue(
  table: OutboxItem["table"],
  op: OutboxItem["op"],
  rowId: string,
  payload: unknown,
) {
  const shopId = table === "shops" ? rowId : (payload as { shopId?: string } | null)?.shopId;
  await db.outbox.add({ table, op, rowId, shopId, payload, createdAt: Date.now() });
}

const ALL = shopTables;

/** Append a stock move (inside the caller's transaction). */
async function addMove(
  p: Pick<Product, "id" | "shopId">,
  delta: number,
  reason: StockMove["reason"],
  at: number,
  refId?: string,
  extra: Pick<StockMove, "shortBy" | "counted" | "note" | "unitCost"> = {},
  /** Fixed id (bills from orders): the same bill made on two phones moves stock once. */
  id?: string,
) {
  const d = round2(delta);
  if (d === 0 && reason !== "count") return; // a count that matches is still worth recording
  if (id && (await db.stockMoves.get(id))) return;
  const move: StockMove = { id: id ?? uuid(), shopId: p.shopId, productId: p.id, delta: d, reason, refId, createdAt: at };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") (move as unknown as Record<string, unknown>)[k] = v;
  await db.stockMoves.add(move);
  await enqueue("stock_moves", "upsert", move.id, move);
  return move;
}

export async function updateShop(id: string, changes: Partial<Shop>) {
  await db.transaction("rw", ALL(), async () => {
    const shop = await db.shops.get(id);
    if (!shop) return;
    const next = { ...shop, ...changes, updatedAt: Date.now() };
    await db.shops.put(next);
    await enqueue("shops", "upsert", id, next);
  });
}

export type ProductInput = Omit<Product, "id" | "shopId" | "createdAt" | "updatedAt" | "salesCount" | "lastSoldAt">;

/** Packed / loose rules broken when saving a product. */
export class ProductError extends Error {
  constructor(public code: "unit" | "packQty" | "step" | "mrp" | "packLink" | "packSize") {
    super(code);
  }
}

/**
 * Packed vs loose (item 14): the kind matches the unit; loose items have a step and no MRP / pack link;
 * packed items have whole-number stock, an optional MRP and optionally the loose product they open into.
 */
async function applyKind(product: Product, existing: Product | undefined, asked: ProductKind | undefined) {
  // Callers that don't know about kinds (starter list, older forms) get the kind of the unit.
  const kind: ProductKind = asked ?? kindForUnit(product.unit);
  if (!unitsFor(kind).includes(product.unit)) throw new ProductError("unit");
  product.kind = kind;
  if (kind === "loose") {
    delete product.mrp;
    delete product.looseId;
    delete product.packSize;
    if (product.step === undefined || product.step === null) delete product.step;
    else if (!validStep(product.step)) throw new ProductError("step");
    else product.step = round2(product.step);
    return;
  }
  delete product.step;
  if (!Number.isInteger(existing ? existing.qty : product.qty)) throw new ProductError("packQty");
  if (product.mrp === undefined || product.mrp === null || product.mrp === 0) delete product.mrp;
  else if (!validAmount(product.mrp)) throw new ProductError("mrp");
  else product.mrp = round2(product.mrp);
  if (!product.looseId) {
    delete product.looseId;
    delete product.packSize;
    return;
  }
  const loose = await db.products.get(product.looseId);
  if (!loose || loose.shopId !== product.shopId || loose.id === product.id || kindOf(loose) !== "loose") throw new ProductError("packLink");
  if (!(product.packSize && validQtyFor(product.packSize, loose.unit))) throw new ProductError("packSize");
  product.packSize = round2(product.packSize);
}

export async function saveProduct(shopId: string, input: ProductInput, id?: string) {
  return db.transaction("rw", ALL(), async () => await saveProductInTransaction(shopId, input, id));
}

async function saveProductInTransaction(shopId: string, input: ProductInput, id?: string) {
  const now = Date.now();
    const existing = id ? await db.products.get(id) : undefined;
    // Editing details never overwrites stock (the form may be stale): quantity changes only via
    // stock moves (sale, return, ± or a reasoned correction).
    const product: Product = existing
      ? { ...existing, ...input, qty: existing.qty, updatedAt: now }
      : { ...input, qty: round2(input.qty), id: uuid(), shopId, salesCount: 0, createdAt: now, updatedAt: now };
    // When the buy price was entered: kept unless the price itself changed ("old buy price" checks).
    const buy = Number.isFinite(product.buyPrice) && product.buyPrice > 0 ? round2(product.buyPrice) : 0;
    product.buyPrice = buy;
    if (!buy) delete product.buyPriceAt;
    else if (!existing || existing.buyPrice !== buy) product.buyPriceAt = now;
    else product.buyPriceAt = existing.buyPriceAt;
    if (product.buyPriceAt === undefined) delete product.buyPriceAt;
    // Supplier diary: the typed supplier name gets (or finds) a supplier record.
    const supplierName = product.supplier?.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!supplierName) {
      delete product.supplier;
      delete product.supplierId;
    } else {
      product.supplier = supplierName;
      const all = await db.suppliers.where("shopId").equals(shopId).toArray();
      let s = all.find((x) => x.id === product.supplierId && normName(x.name) === normName(supplierName)) ?? all.find((x) => normName(x.name) === normName(supplierName));
      if (!s) {
        const sid = supplierIdFor(shopId, supplierName);
        s = { id: (await db.suppliers.get(sid)) ? uuid() : sid, shopId, name: supplierName, items: product.nameHi || product.nameEn, createdAt: now, updatedAt: now } satisfies Supplier;
        await db.suppliers.put(s);
        await enqueue("suppliers", "upsert", s.id, s);
      }
      product.supplierId = s.id;
    }
    if (!(product.reorderTo && product.reorderTo > 0)) delete product.reorderTo;
    else product.reorderTo = round2(product.reorderTo);
    await applyKind(product, existing, input.kind);
    await db.products.put(product);
    await enqueue("products", "upsert", product.id, product);
    if (!existing) await addMove(product, product.qty, "opening", now);
    return product;
}

/** All rows, opening moves and sync records commit together or none do. */
export async function importProducts(shopId: string, inputs: ProductInput[]) {
  if (!inputs.length || inputs.length > 500) throw new Error("importInvalid");
  return db.transaction("rw", ALL(), async () => {
    const current = await db.products.where("shopId").equals(shopId).toArray();
    const names = new Set(current.flatMap((p) => [p.nameHi, p.nameEn].filter(Boolean).map(normName)));
    const barcodes = new Set(current.map((p) => p.barcode).filter(Boolean));
    const created: Product[] = [];
    for (const input of inputs) {
      const key = normName(input.nameHi || input.nameEn);
      if (!key || key.length > 80 || names.has(key) || (input.barcode && barcodes.has(input.barcode))) throw new Error("importChanged");
      if (!validAmount(input.sellPrice) || !Number.isFinite(input.buyPrice) || input.buyPrice < 0 || input.buyPrice > 100000 || !validQtyFor(input.qty, input.unit, true)) throw new Error("importInvalid");
      names.add(key);
      if (input.barcode) barcodes.add(input.barcode);
      created.push(await saveProductInTransaction(shopId, input));
    }
    return created;
  });
}

/** One-tap setup edit. A counted stock change remains visible in stock history. */
export async function quickSetProduct(shopId: string, id: string, sellPrice: number, buyPrice: number, counted: number) {
  if (!validAmount(sellPrice) || !Number.isFinite(buyPrice) || buyPrice < 0 || buyPrice > 100000) throw new Error("quickPrice");
  return db.transaction("rw", ALL(), async () => {
    const p = await db.products.get(id);
    if (!p || p.shopId !== shopId) throw new Error("quickMissing");
    if (!validQtyFor(counted, p.unit, true)) throw new Error("quickQty");
    const now = Date.now();
    const next: Product = { ...p, sellPrice: round2(sellPrice), buyPrice: round2(buyPrice), qty: round2(counted) };
    if (next.sellPrice !== p.sellPrice || next.buyPrice !== p.buyPrice) {
      next.updatedAt = Math.max(now, p.updatedAt + 1);
      if (next.buyPrice !== p.buyPrice) {
        if (next.buyPrice) next.buyPriceAt = now;
        else delete next.buyPriceAt;
      }
    }
    if (next.qty === p.qty && next.sellPrice === p.sellPrice && next.buyPrice === p.buyPrice) return p;
    await db.products.put(next);
    await enqueue("products", "upsert", p.id, next);
    if (next.qty !== p.qty) await addMove(p, round2(next.qty - p.qty), "count", now, undefined, { counted: next.qty, note: "Setup count" });
    return next;
  });
}

export async function deleteProduct(id: string) {
  await db.transaction("rw", ALL(), async () => {
    const p = await db.products.get(id);
    if (!p) return;
    await db.products.delete(id);
    // Synced as a tombstone (full row + deletedAt) so other phones remove it too.
    const now = Date.now();
    await enqueue("products", "upsert", id, { ...p, deletedAt: now, updatedAt: now });
  });
}

/** Quick ± on the stock screen. Never clamped: going below zero is recorded, not hidden. */
export async function adjustStock(id: string, delta: number) {
  await db.transaction("rw", ALL(), async () => {
    const p = await db.products.get(id);
    if (!p || !Number.isFinite(delta) || round2(delta) === 0) return;
    const next = { ...p, qty: round2(p.qty + delta) };
    await db.products.put(next);
    await enqueue("products", "upsert", id, next);
    await addMove(p, round2(delta), "adjust", Date.now());
  });
}

export class StockError extends Error {
  constructor(public code: "notFound" | "qty" | "reason") {
    super(code);
  }
}

/**
 * A reasoned stock correction, recorded as a move (never an overwrite):
 * - "count": `qty` is what was counted; the move is the difference to the record.
 * - "damage" / "theft": `qty` left the shop.
 * - "purchase": `qty` arrived earlier but was not entered.
 */
export async function recordStockAdjustment(opts: { productId: string; reason: AdjustReason; qty: number; note?: string }) {
  if (!(ADJUST_REASONS as readonly string[]).includes(opts.reason)) throw new StockError("reason");
  const qty = round2(opts.qty);
  if (!Number.isFinite(qty) || qty < 0 || (opts.reason !== "count" && qty === 0)) throw new StockError("qty");
  return db.transaction("rw", ALL(), async () => {
    const p = await db.products.get(opts.productId);
    if (!p) throw new StockError("notFound");
    const delta = opts.reason === "count" ? round2(qty - p.qty) : opts.reason === "purchase" ? qty : -qty;
    const next: Product = { ...p, qty: round2(p.qty + delta) };
    await db.products.put(next);
    await enqueue("products", "upsert", p.id, next);
    const move = await addMove(p, delta, opts.reason, Date.now(), undefined, {
      counted: opts.reason === "count" ? qty : undefined,
      note: opts.note?.trim() || undefined,
      // Losses are valued at the buy price of that moment (none known = listed, not valued).
      unitCost: (opts.reason === "damage" || opts.reason === "theft") && p.buyPrice > 0 ? p.buyPrice : undefined,
    });
    return { product: next, move: move! };
  });
}

/**
 * Open sealed packs into loose stock (e.g. 2 × 1 kg atta packets → +2 kg loose atta): two "openPack"
 * moves with the same refId, one out of the pack product and one into the loose product. Like a sale it
 * never blocks: opening more packs than on record is recorded (shortBy) and the stock goes negative.
 */
export async function openPack(opts: { productId: string; packs: number; note?: string; at?: number }) {
  if (!Number.isInteger(opts.packs) || opts.packs < 1 || opts.packs > 10000) throw new StockError("qty");
  return db.transaction("rw", ALL(), async () => {
    const pack = await db.products.get(opts.productId);
    if (!pack || kindOf(pack) !== "packed" || !pack.looseId || !pack.packSize) throw new StockError("notFound");
    const loose = await db.products.get(pack.looseId);
    if (!loose || loose.shopId !== pack.shopId) throw new StockError("notFound");
    const now = opts.at ?? Date.now();
    const ref = uuid();
    const add = round2(opts.packs * pack.packSize);
    const note = opts.note?.trim().slice(0, 200) || undefined;
    const short = shortfall(pack.qty, opts.packs);
    const nextPack: Product = { ...pack, qty: round2(pack.qty - opts.packs) };
    const nextLoose: Product = { ...loose, qty: round2(loose.qty + add) };
    await db.products.put(nextPack);
    await enqueue("products", "upsert", pack.id, nextPack);
    await db.products.put(nextLoose);
    await enqueue("products", "upsert", loose.id, nextLoose);
    const out = await addMove(pack, -opts.packs, "openPack", now, ref, { note, shortBy: short > 0 ? short : undefined }, `${ref}-out`);
    const into = await addMove(loose, add, "openPack", now, ref, { note }, `${ref}-in`);
    return { out: out!, into: into!, pack: nextPack, loose: nextLoose };
  });
}

/** How much of `qty` is more than the stock on record (0 when there is enough). */
export const shortfall = (onRecord: number, qty: number) => Math.max(0, round2(qty - Math.max(0, onRecord)));

const cleanText = (v: string | undefined, max: number) => v?.trim().replace(/\s+/g, " ").slice(0, max) || undefined;

export async function addCustomer(shopId: string, name: string, phone?: string, more: { address?: string; landmark?: string } = {}) {
  const now = Date.now();
  const c: Customer = {
    id: uuid(),
    shopId,
    name: name.trim(),
    phone: phone?.replace(/\D/g, "") || undefined,
    balance: 0,
    createdAt: now,
    updatedAt: now,
  };
  const address = cleanText(more.address, 200);
  const landmark = cleanText(more.landmark, 120);
  if (address) c.address = address;
  if (landmark) c.landmark = landmark;
  await db.transaction("rw", ALL(), async () => {
    await db.customers.add(c);
    await enqueue("customers", "upsert", c.id, c);
  });
  return c;
}

/** Edit a customer's name / phone / delivery address (the balance is never touched: it is the ledger's sum). */
export async function updateCustomer(id: string, input: { name: string; phone?: string; address?: string; landmark?: string }) {
  const name = input.name.trim();
  if (!name) throw new Error("Customer name required");
  return db.transaction("rw", ALL(), async () => {
    const c = await db.customers.get(id);
    if (!c) throw new Error("Customer not found");
    const next: Customer = { ...c, name, updatedAt: Math.max(Date.now(), (c.updatedAt ?? 0) + 1) };
    const phone = input.phone?.replace(/\D/g, "");
    const address = cleanText(input.address, 200);
    const landmark = cleanText(input.landmark, 120);
    if (phone) next.phone = phone;
    else delete next.phone;
    if (address) next.address = address;
    else delete next.address;
    if (landmark) next.landmark = landmark;
    else delete next.landmark;
    await db.customers.put(next);
    await enqueue("customers", "upsert", id, next);
    return next;
  });
}

async function applyLedger(entry: LedgerEntry) {
  const c = await db.customers.get(entry.customerId);
  if (!c || c.shopId !== entry.shopId) throw new Error("Customer not found");
  if (!Number.isFinite(entry.amount) || entry.amount <= 0) throw new Error("Invalid amount");
  if (await db.ledger.get(entry.id)) return; // fixed ids (bills from orders) are written once
  await db.ledger.add(entry);
  await enqueue("credit_ledger", "upsert", entry.id, entry);
  const delta = entry.type === "debit" ? entry.amount : -entry.amount;
  const next: Customer = {
    ...c,
    balance: round2(c.balance + delta),
    // A return reduces udhaar but is not a payment by the customer.
    lastPaidAt: entry.type === "credit" && entry.kind !== "return" ? entry.createdAt : c.lastPaidAt,
    // updatedAt is for name/phone edits; the balance is the sum of the ledger.
  };
  await db.customers.put(next);
  await enqueue("customers", "upsert", c.id, next);
}

export async function addLedger(
  shopId: string,
  customerId: string,
  type: LedgerEntry["type"],
  amount: number,
  note?: string,
  /** Payments received: cash goes into the drawer, UPI does not. */
  method?: "cash" | "upi",
) {
  const entry: LedgerEntry = {
    id: uuid(),
    shopId,
    customerId,
    type,
    amount: round2(amount),
    note: note?.trim() || undefined,
    method: type === "credit" ? (method ?? "cash") : undefined,
    createdAt: Date.now(),
  };
  await db.transaction("rw", ALL(), () => applyLedger(entry));
  return entry;
}

export interface CartLine {
  /** Discount on this line's full quantity, applied before the bill discount. */
  discount?: BillDiscount;
  product: Product;
  qty: number;
  /** Loose only: original amount (₹), before discounts. qty is derived from it (qtyForAmount). */
  amount?: number;
}

export class SaleLineError extends Error {
  constructor(public code: "qty" | "amount") {
    super(code);
  }
}

export async function recordSale(opts: {
  roundToRupee?: boolean;
  discount?: BillDiscount;
  shopId: string;
  lines: CartLine[];
  /** One-tap single payment (ignored when `payments` is given). */
  payment: PaymentType;
  /** Split payment / cash tendered / UPI confirmation. Amounts must add up to the bill total. */
  payments?: PaymentRequest[];
  /** Udhaar customer, or (item 13) the customer a cash / UPI bill belongs to (repeat orders, lookup). */
  customerId?: string;
  newCustomer?: { name: string; phone?: string };
  draftId?: string;
  /** Bill made from a customer order: the bill id is fixed, and so are its stock moves and udhaar entry. */
  orderId?: string;
}): Promise<Sale> {
  const now = Date.now();
  let items: SaleItem[] = [];
  for (const l of opts.lines) {
    let qty = l.qty;
    let amount: number | undefined;
    if (l.amount !== undefined && l.amount !== null) {
      // "₹20 का सामान": the amount is the anchor; qty follows from today's price (10 g / 10 ml steps).
      const q = validAmount(l.amount) ? qtyForAmount(l.amount, l.product) : null;
      if (q === null) throw new SaleLineError("amount");
      amount = round2(l.amount);
      qty = q;
    }
    if (!(qty > 0)) continue;
    if (!validQtyFor(qty, l.product.unit)) throw new SaleLineError("qty");
    const item: SaleItem = {
      productId: l.product.id,
      nameHi: l.product.nameHi,
      nameEn: l.product.nameEn,
      unit: l.product.unit,
      qty,
      price: l.product.sellPrice,
      // Cost snapshot: the buy price at this moment, or explicitly unknown (never a silent 0).
      ...costSnapshot(l.product),
    };
    if (amount !== undefined) item.amount = amount;
    const itemCut = discountAmount(lineTotal(item), l.discount);
    if (itemCut > 0) { item.itemDiscount = itemCut; item.discount = itemCut; }
    items.push(item);
  }
  items = allocateDiscount(items, opts.discount);
  if (opts.roundToRupee) items = roundSaleItems(items);
  const total = round2(items.reduce((s, i) => s + lineTotal(i), 0));
  const payments = buildPayments(
    total,
    opts.payments ?? [{ method: opts.payment, amount: total, upi: opts.payment === "upi" ? "paid" : undefined }],
    now,
  );
  const creditPart = partSum(payments, "credit");
  const sale: Sale = {
    // A bill from a customer order always has the same id (orders.ts orderBillId): billed once only.
    id: opts.orderId ? `${opts.orderId}-bill` : (opts.draftId ?? uuid()),
    shopId: opts.shopId,
    items,
    total,
    cost: round2(items.reduce((s, i) => s + i.qty * i.cost, 0)),
    payment: paymentKind(payments),
    payments,
    customerId: opts.customerId || undefined,
    createdAt: now,
    day: dayKey(now),
  };
  if (opts.orderId) sale.orderId = opts.orderId;
  const fixed = !!opts.orderId;

  return db.transaction("rw", ALL(), async () => {
    const existing = await db.sales.get(sale.id);
    if (existing) {
      if (existing.shopId !== opts.shopId) throw new Error("Shop mismatch");
      return existing;
    }
    // Customer creation belongs to the same transaction: a failed bill must
    // not leave an orphan customer that gets duplicated when retried.
    if (opts.newCustomer && (creditPart > 0 || opts.newCustomer.name.trim())) {
      if (!opts.newCustomer.name.trim()) throw new Error("Customer name required");
      sale.customerId = (await addCustomer(opts.shopId, opts.newCustomer.name, opts.newCustomer.phone)).id;
    }
    if (creditPart > 0 && !sale.customerId) throw new PaymentError("customer");
    // A cash / UPI bill keeps its customer only when that customer exists (lookup, repeat last bill).
    if (sale.customerId && creditPart <= 0) {
      const c = await db.customers.get(sale.customerId);
      if (!c || c.shopId !== opts.shopId) delete sale.customerId;
    }
    await db.sales.add(sale);
    await enqueue("sales", "upsert", sale.id, sale);
    for (const [i, item] of items.entries()) {
      const p = await db.products.get(item.productId);
      if (!p) continue;
      // Never block or clamp at the counter: the full quantity leaves stock and any shortfall is
      // recorded on the move, so the shortage stays visible until someone counts.
      const next: Product = {
        ...p,
        qty: round2(p.qty - item.qty),
        lastSoldAt: now,
        salesCount: (p.salesCount ?? 0) + 1,
      };
      await db.products.put(next);
      await enqueue("products", "upsert", p.id, next);
      const short = shortfall(p.qty, item.qty);
      await addMove(p, -item.qty, "sale", now, sale.id, { shortBy: short > 0 ? short : undefined }, fixed ? `${sale.id}-m${i}` : undefined);
    }
    // Only the udhaar part goes on the customer's ledger.
    if (creditPart > 0 && sale.customerId) {
      await applyLedger({
        id: fixed ? `${sale.id}-udhaar` : uuid(),
        shopId: sale.shopId,
        customerId: sale.customerId,
        type: "debit",
        amount: creditPart,
        saleId: sale.id,
        createdAt: now,
      });
    }
    const draft = await db.saleDrafts.get(opts.shopId);
    if (draft?.id === opts.draftId) await db.saleDrafts.delete(opts.shopId);
    return sale;
  });
}

/* ------------------------------------------------------------------ */
/* Bill cancellation & returns                                         */
/* ------------------------------------------------------------------ */

export class CorrectionError extends Error {
  constructor(public code: "notFound" | "cancelled" | "over" | "empty" | "reason" | "method") {
    super(code);
  }
}

const EPS = 1e-9;
export const saleStatus = (s: Sale) => s.status ?? "active";
export const remainingQty = (item: Sale["items"][number]) => round2(item.qty - (item.returnedQty ?? 0));
export const netTotal = (s: Sale) => round2(s.total - (s.returnedTotal ?? 0));
export const netCost = (s: Sale) => round2(s.cost - (s.returnedCost ?? 0));

/**
 * Refund routes a bill allows, given its earlier corrections: udhaar while the credit part lasts,
 * cash/UPI while money actually received lasts. Pending UPI is reduced first automatically.
 */
export const refundMethodsFor = (s: Sale, corrections: SaleCorrection[] = []): RefundMethod[] => refundChoices(s, corrections);

/**
 * Return some lines (type "return") or everything still on the bill (type "cancel").
 * One transaction: bill status/returned totals, stock back, udhaar reduced (credit refunds),
 * an append-only correction record, and outbox entries for sync. The original bill is never deleted.
 */
export async function correctSale(opts: {
  saleId: string;
  type: "return" | "cancel";
  lines?: { index: number; qty: number }[]; // required for "return"
  reason: string;
  refundMethod: RefundMethod;
  /** Explicitly refund through cash/UPI beyond what that method brought in (shown with a warning). */
  crossMethod?: boolean;
  byUserId?: string;
  byName?: string;
}): Promise<SaleCorrection> {
  const reason = opts.reason.trim();
  if (!reason) throw new CorrectionError("reason");

  return db.transaction("rw", ALL(), async () => {
    const sale = await db.sales.get(opts.saleId);
    if (!sale) throw new CorrectionError("notFound");
    if (saleStatus(sale) === "cancelled") throw new CorrectionError("cancelled");
    const earlier = await db.corrections.where("saleId").equals(sale.id).toArray();
    const choices = refundMethodsFor(sale, earlier);
    // No choice at all = everything left is unconfirmed UPI, which is simply reduced.
    const cross = !!opts.crossMethod && opts.refundMethod !== "credit";
    if (choices.length && !choices.includes(opts.refundMethod) && !cross) throw new CorrectionError("method");

    // Requested quantities per line index (merging duplicates).
    const want = new Map<number, number>();
    if (opts.type === "cancel") {
      sale.items.forEach((it, i) => {
        const left = remainingQty(it);
        if (left > EPS) want.set(i, left);
      });
    } else {
      for (const l of opts.lines ?? []) {
        if (!sale.items[l.index] || !validQtyFor(l.qty, sale.items[l.index].unit, true)) throw new CorrectionError("over");
        if (l.qty > 0) want.set(l.index, round2((want.get(l.index) ?? 0) + l.qty));
      }
    }
    if (want.size === 0) throw new CorrectionError(opts.type === "cancel" ? "cancelled" : "empty");

    const lines: CorrectionLine[] = [];
    const items = sale.items.map((it) => ({ ...it }));
    for (const [index, qty] of want) {
      const it = items[index];
      if (!it || qty > remainingQty(it) + EPS) throw new CorrectionError("over");
      const before = it.returnedQty ?? 0;
      it.returnedQty = round2(before + qty);
      const line: CorrectionLine = { index, productId: it.productId, nameHi: it.nameHi, nameEn: it.nameEn, unit: it.unit, qty, price: it.price, cost: it.cost, costKnown: costKnown(it) };
      // Amount-based line: the part given back is valued pro rata of what was paid (all of it = the amount).
      if (it.amount !== undefined || it.discount !== undefined || it.rounding !== undefined) line.amount = partValue(it, qty, before);
      lines.push(line);
    }

    const now = Date.now();
    const allBack = items.every((it) => remainingQty(it) <= EPS);
    // Fully reversed: give back exactly what is left so rounding never drifts.
    const amount = allBack ? netTotal(sale) : round2(lines.reduce((a, l) => a + (l.amount ?? l.qty * l.price), 0));
    const cost = allBack ? netCost(sale) : round2(lines.reduce((a, l) => a + l.qty * l.cost, 0));

    const refunds = planRefund(sale, earlier, amount, opts.refundMethod, cross);
    const creditBack = round2(refunds.filter((r) => r.method === "credit").reduce((a, r) => a + r.amount, 0));
    const pendingBack = round2(refunds.filter((r) => r.method === "upiPending").reduce((a, r) => a + r.amount, 0));

    const correction: SaleCorrection = {
      id: uuid(),
      shopId: sale.shopId,
      saleId: sale.id,
      type: opts.type,
      reason,
      lines,
      amount,
      cost,
      refundMethod: opts.refundMethod,
      refunds,
      crossMethod: cross && crossAmount(sale, earlier, amount, opts.refundMethod) > 0 ? true : undefined,
      customerId: sale.customerId,
      byUserId: opts.byUserId,
      byName: opts.byName,
      createdAt: now,
      day: dayKey(now),
    };

    // Unconfirmed UPI that is no longer owed simply shrinks (no money moved).
    let payments = paymentsOf(sale).map((p) => ({ ...p }));
    let cut = pendingBack;
    for (const p of payments) {
      if (cut <= 0) break;
      if (p.method !== "upi" || p.status !== "pending") continue;
      const x = Math.min(cut, p.amount);
      p.amount = round2(p.amount - x);
      cut = round2(cut - x);
    }
    payments = payments.filter((p) => !(p.method === "upi" && p.status === "pending" && p.amount <= 0));
    const nextSale: Sale = {
      ...sale,
      payments,
      items,
      returnedTotal: round2((sale.returnedTotal ?? 0) + amount),
      returnedCost: round2((sale.returnedCost ?? 0) + cost),
      status: allBack ? "cancelled" : "partially_returned",
      updatedAt: now,
    };
    await db.sales.put(nextSale);
    await enqueue("sales", "upsert", sale.id, nextSale);

    for (const l of lines) {
      const p = await db.products.get(l.productId);
      if (!p) continue; // product deleted since the sale: money is still reversed
      const next: Product = { ...p, qty: round2(p.qty + l.qty) };
      await db.products.put(next);
      await enqueue("products", "upsert", p.id, next);
      await addMove(p, l.qty, "return", now, correction.id);
    }

    if (creditBack > 0 && sale.customerId) {
      await applyLedger({
        id: uuid(),
        shopId: sale.shopId,
        customerId: sale.customerId,
        type: "credit",
        kind: "return",
        amount: creditBack,
        note: reason,
        saleId: sale.id,
        correctionId: correction.id,
        createdAt: now,
      });
    }

    await db.corrections.add(correction);
    await enqueue("sale_corrections", "upsert", correction.id, correction);
    return correction;
  });
}

/**
 * Settle a bill's pending UPI part: "upi" = money arrived (optional UTR / last digits),
 * "cash" = the customer paid cash instead, "credit" = put it on the customer's udhaar.
 */
export async function settlePendingUpi(opts: {
  saleId: string;
  to: "upi" | "cash" | "credit";
  ref?: string;
  customerId?: string;
  newCustomer?: { name: string; phone?: string };
}): Promise<Sale> {
  return db.transaction("rw", ALL(), async () => {
    const sale = await db.sales.get(opts.saleId);
    if (!sale) throw new PaymentError("notFound");
    const parts = paymentsOf(sale).map((p) => ({ ...p }));
    const idx = parts.findIndex((p) => p.method === "upi" && p.status === "pending" && p.amount > 0);
    if (idx < 0 || saleStatus(sale) === "cancelled") throw new PaymentError("notPending");
    const part = parts[idx];
    const now = Date.now();
    let customerId = sale.customerId;
    if (opts.to === "upi") {
      part.status = "paid";
      part.confirmedAt = now;
      const ref = opts.ref?.trim();
      if (ref) part.ref = ref.slice(0, 40);
    } else {
      if (opts.to === "credit") {
        if (!customerId) {
          if (opts.newCustomer?.name.trim()) customerId = (await addCustomer(sale.shopId, opts.newCustomer.name, opts.newCustomer.phone)).id;
          else customerId = opts.customerId;
        }
        if (!customerId) throw new PaymentError("customer");
      }
      parts.splice(idx, 1);
      // Keep receipts separate: an earlier cash part belongs to its original day.
      parts.push({ method: opts.to, amount: part.amount, status: "paid", convertedFrom: "upi", confirmedAt: now });
    }
    const next: Sale = { ...sale, payments: parts, payment: paymentKind(parts), customerId, updatedAt: now };
    await db.sales.put(next);
    await enqueue("sales", "upsert", sale.id, next);
    if (opts.to === "credit" && customerId) {
      await applyLedger({
        id: uuid(),
        shopId: sale.shopId,
        customerId,
        type: "debit",
        amount: part.amount,
        note: "UPI → udhaar",
        saleId: sale.id,
        createdAt: now,
      });
    }
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Add a missing buy price (from the profit report)                    */
/* ------------------------------------------------------------------ */

/**
 * Set a product's buy price. With `fillPast`, earlier bill lines of this product that had no buy
 * price get it too, marked `costFilled` (an estimate: today's price for an older sale). Lines that
 * already had a cost are never changed. Returns how many bill lines were filled.
 */
export async function setBuyPrice(productId: string, price: number, fillPast: boolean): Promise<number> {
  const buy = round2(price);
  if (!Number.isFinite(buy) || buy <= 0) throw new StockError("qty");
  return db.transaction("rw", ALL(), async () => {
    const p = await db.products.get(productId);
    if (!p) throw new StockError("notFound");
    const now = Date.now();
    if (p.buyPrice !== buy) {
      const next: Product = { ...p, buyPrice: buy, buyPriceAt: now, updatedAt: now };
      await db.products.put(next);
      await enqueue("products", "upsert", p.id, next);
    }
    if (!fillPast) return 0;
    let filled = 0;
    const sales = await db.sales.where("shopId").equals(p.shopId).filter((s) => s.items.some((it) => it.productId === productId && !costKnown(it))).toArray();
    for (const s of sales) {
      const items = s.items.map((it) => {
        if (it.productId !== productId || costKnown(it)) return it;
        filled++;
        return { ...it, cost: buy, costKnown: true, costFilled: true };
      });
      const next: Sale = { ...s, items, cost: round2(items.reduce((a, i) => a + i.qty * (costKnown(i) ? i.cost : 0), 0)), updatedAt: now };
      await db.sales.put(next);
      await enqueue("sales", "upsert", s.id, next);
    }
    return filled;
  });
}
