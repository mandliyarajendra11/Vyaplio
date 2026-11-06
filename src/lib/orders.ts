/**
 * WhatsApp repeat orders (item 13): saved household baskets, "repeat last bill", incoming customer
 * orders (from a basket, a repeat or pasted WhatsApp text) with a packing checklist and a status
 * history, and the one bill each order turns into.
 *
 *  - Baskets and order rows are edited (last write wins). The order's status is never stored on the
 *    row: it comes from the append-only order events, so two phones never undo each other's step.
 *  - An order is not a bill: stock and money move only when it becomes one (at packing or at
 *    delivery, chosen per order). The bill id, its stock moves and its udhaar entry have fixed ids
 *    (`<order>-bill`, `-m<n>`, `-udhaar`), so billing twice – on one phone or on two – bills once.
 */
import { v4 as uuid } from "uuid";
import type { useTranslations } from "next-intl";
import {
  db,
  shopTables,
  ORDER_STATUSES,
  type Basket,
  type BasketLine,
  type BillAt,
  type Customer,
  type CustomerOrder,
  type CustomerOrderLine,
  type Locale,
  type OrderEvent,
  type OrderSource,
  type OrderStatus,
  type PaymentType,
  type Product,
  type RepeatInfo,
  type Sale,
  type Shop,
  type Unit,
} from "./db";
import { dayKey, fmtDate } from "./dates";
import { formatINR, formatNum, round2 } from "./money";
import { names } from "./names";
import { addCustomer, enqueue, netTotal, recordSale, remainingQty, saleStatus, type CartLine } from "./ops";
import type { PaymentRequest } from "./payments";
import { kindOf, qtyForAmount, validAmount, validQtyFor } from "./units";
import { buildIndex, closest, searchIndex, Tier } from "./search";
import { parseSpokenQuantity, qtyForProduct } from "./voiceParse";

type T = ReturnType<typeof useTranslations>;
const ALL = shopTables;

export class OrderError extends Error {
  constructor(public code: "customer" | "lines" | "qty" | "notFound" | "status" | "billed" | "payment" | "name" | "empty" | "noBill") {
    super(code);
  }
}

/* ------------------------------ status machine ------------------------------ */

/** Short number shown on the order, its messages and the packing list. */
export const orderNo = (o: Pick<CustomerOrder, "id">) => o.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 5).toUpperCase();
/** The order's bill always has this id (so it can only be made once). */
export const orderBillId = (orderId: string) => `${orderId}-bill`;

const RANK: Record<Exclude<OrderStatus, "cancelled">, number> = { new: 0, packing: 1, ready: 2, out: 3, picked: 4, delivered: 4 };
/** Allowed next steps. "picked" (customer collected it) and "delivered" are done. */
export const NEXT: Record<OrderStatus, OrderStatus[]> = {
  new: ["packing", "cancelled"],
  packing: ["ready", "cancelled"],
  ready: ["out", "picked", "cancelled"],
  out: ["delivered", "cancelled"],
  picked: [],
  delivered: [],
  cancelled: [],
};
export const PENDING_STATUSES: OrderStatus[] = ["new", "packing", "ready", "out"];
export const isPending = (s: OrderStatus) => PENDING_STATUSES.includes(s);
export const isDone = (s: OrderStatus) => s === "picked" || s === "delivered";
export const canMove = (from: OrderStatus, to: OrderStatus) => NEXT[from].includes(to);

/** Does moving to `to` turn the order into its bill? */
export const billsOn = (billAt: BillAt, to: OrderStatus) =>
  to !== "cancelled" && (billAt === "packed" ? RANK[to] >= RANK.ready : isDone(to));

export interface OrderState {
  status: OrderStatus;
  /** The bill (sale id) once the order became one. */
  saleId?: string;
  /** When each status was reached (first time). */
  at: Partial<Record<OrderStatus, number>>;
}

/**
 * Status from the event history: the furthest step reached; "cancelled" only while no bill exists
 * (a billed order is corrected on the bill: return / cancel). `billExists` = the fixed bill id is on
 * this phone (its event may still be on its way from the other phone).
 */
export function orderState(events: Pick<OrderEvent, "type" | "status" | "saleId" | "createdAt">[], billExists = false, orderId?: string): OrderState {
  const at: OrderState["at"] = {};
  let status: Exclude<OrderStatus, "cancelled"> = "new";
  let cancelled = false;
  let saleId: string | undefined;
  for (const e of [...events].sort((a, b) => a.createdAt - b.createdAt)) {
    if (e.type === "bill" && e.saleId) saleId ??= e.saleId;
    if (e.type !== "status" || !e.status || !(ORDER_STATUSES as readonly string[]).includes(e.status)) continue;
    at[e.status] ??= e.createdAt;
    if (e.status === "cancelled") cancelled = true;
    else if (RANK[e.status] > RANK[status] || (e.status === "delivered" && status === "picked")) status = e.status;
  }
  if (!saleId && billExists && orderId) saleId = orderBillId(orderId);
  return { status: cancelled && !saleId ? "cancelled" : status, saleId, at };
}

/** Quantity that goes on the bill: what was packed (missing = as asked). */
export const billQty = (l: CustomerOrderLine) => round2(l.packedQty ?? l.qty);

/** Asked by amount and packed as asked: the bill is made for that ₹ amount (qty derived at the billing price). */
export const billAmount = (l: CustomerOrderLine) => (l.amount !== undefined && (l.packedQty === undefined || l.packedQty === l.qty) ? l.amount : undefined);

/** Rough total at today's prices (the bill itself is made at the prices of the billing moment). */
export function orderTotal(o: Pick<CustomerOrder, "lines">, byId?: Map<string, Pick<Product, "sellPrice">>, packed = false) {
  return round2(
    o.lines.reduce((a, l) => {
      const amt = packed ? billAmount(l) : l.amount;
      return a + (amt ?? (packed ? billQty(l) : l.qty) * (byId?.get(l.productId)?.sellPrice ?? l.price));
    }, 0),
  );
}

/* ------------------------------ quantities ------------------------------ */

/** A quantity that fits the unit (whole numbers for pieces / packets / boxes, 10 g / 10 ml steps for loose). */
export const validQty = (q: number, unit: Unit, allowZero = false) => validQtyFor(q, unit, allowZero);

/* ------------------------------ pasted WhatsApp text ------------------------------ */

export interface ParsedOrderLine {
  raw: string;
  productId: string;
  qty: number;
  /** No (usable) quantity in the text: 1 unit was assumed – check it. */
  qtyGuessed: boolean;
  /** Loose item asked by amount ("20 rupaye ki chini"): qty is derived from it. */
  amount?: number;
  /** Asked by amount for a pack ("₹20 ka biscuit"): packs are sold by count, 1 assumed – check it. */
  amountOnPack?: boolean;
}
export interface UnmatchedLine {
  raw: string;
  /** Quantity read from the line (applied when a product is picked). */
  said: { qty: number | null; unit: ReturnType<typeof parseSpokenQuantity>["unit"]; amount?: number };
  /** Best guesses to pick from (may be empty). */
  options: string[];
}

const BULLET = /^\s*(?:[-*•·>]+|\d{1,2}\s*[.)]|\(\d{1,2}\))\s*/u;
const JOIN = /\s+(?:aur|and|और|&)\s+/iu;

/** Split a WhatsApp message into item lines: new lines, commas, "aur"; list numbers and bullets removed. */
export function splitOrderText(text: string): string[] {
  return text
    .normalize("NFC")
    .split(/[\n\r;,،]+/u)
    .flatMap((l) => l.split(JOIN))
    .map((l) =>
      l
        .replace(BULLET, "")
        .replace(/\b[x×]\s*(\d+)\b/giu, " $1") // "maggi x2"
        .replace(/[*_~]/g, " ") // WhatsApp bold / italics
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
}

/**
 * Read a pasted order with the counter's product matcher and quantity parser ("do kilo chini",
 * "aata 5 kilo", "2 packet maggi"). A line becomes an item only when exactly one product clearly
 * matches (name / alias level, as for voice); everything else is listed for a manual pick.
 */
export function parseOrderText<P extends Product>(text: string, products: readonly P[]): { lines: ParsedOrderLine[]; unmatched: UnmatchedLine[] } {
  const index = buildIndex(products);
  const lines: ParsedOrderLine[] = [];
  const unmatched: UnmatchedLine[] = [];
  for (const raw of splitOrderText(text)) {
    const said = parseSpokenQuantity(raw);
    const rest = (said.rest || "").trim();
    const hits = rest ? searchIndex(index, rest, { limit: 3 }) : [];
    const top = hits[0];
    const clear = !!top && top.tier >= Tier.Alias && (hits.length === 1 || hits[1].tier < top.tier);
    if (!clear) {
      const options = (hits.length ? hits.map((h) => h.product) : rest ? closest(index, rest) : []).map((p) => p.id);
      unmatched.push({ raw, said: { qty: said.qty, unit: said.unit, ...(said.amount !== undefined ? { amount: said.amount } : {}) }, options: [...new Set(options)] });
      continue;
    }
    const p = top.product;
    const pick = pickQty(said, p);
    const same = lines.find((l) => l.productId === p.id);
    if (same) {
      // Two amounts for one item add up; mixing an amount with a weight keeps the weight only.
      same.amount = same.amount !== undefined && pick.amount !== undefined ? round2(same.amount + pick.amount) : undefined;
      same.qty = same.amount !== undefined ? (qtyForAmount(same.amount, p) ?? round2(same.qty + pick.qty)) : round2(same.qty + pick.qty);
      if (same.amount === undefined) delete same.amount;
      same.qtyGuessed ||= pick.guessed;
      if (pick.amountOnPack) same.amountOnPack = true;
      same.raw += " + " + raw;
    } else lines.push({ raw, productId: p.id, qty: pick.qty, qtyGuessed: pick.guessed, ...(pick.amount !== undefined ? { amount: pick.amount } : {}), ...(pick.amountOnPack ? { amountOnPack: true } : {}) });
  }
  return { lines, unmatched };
}

/**
 * What a said / pasted line puts on the order for a product: an amount on a loose item → qty from the
 * price (₹20 of ₹45/kg chini = 440 g); an amount on a pack can't be sold by money → 1 piece, flagged.
 * No usable quantity → 1 unit, flagged.
 */
export function pickQty(said: UnmatchedLine["said"], p: Pick<Product, "unit" | "sellPrice" | "kind">): { qty: number; guessed: boolean; amount?: number; amountOnPack?: boolean } {
  if (said.amount !== undefined) {
    const q = qtyForAmount(said.amount, p);
    if (q !== null) return { qty: q, guessed: false, amount: round2(said.amount) };
    return kindOf(p) === "packed" ? { qty: 1, guessed: true, amountOnPack: true } : { qty: 1, guessed: true };
  }
  const q = qtyForProduct(said, p.unit);
  return { qty: q ?? 1, guessed: q === null };
}

/** Quantity for a line picked by hand from an unmatched line (1 unit when unclear). */
export const qtyForPick = (said: UnmatchedLine["said"], unit: Unit) => qtyForProduct(said, unit) ?? 1;

/* ------------------------------ baskets ------------------------------ */

const lineOf = (p: Product, qty: number, amount?: number): BasketLine => ({
  productId: p.id,
  nameHi: p.nameHi,
  nameEn: p.nameEn,
  unit: p.unit,
  qty: round2(qty),
  price: p.sellPrice,
  ...(amount !== undefined ? { amount } : {}),
});

/** An order / basket line as entered: qty, or (loose items) a ₹ amount the qty is derived from. */
export interface LineInput {
  productId: string;
  qty: number;
  amount?: number;
}

/** Merge, validate and snapshot basket / order lines against the products on record. */
async function cleanLines(shopId: string, input: LineInput[]): Promise<BasketLine[]> {
  const merged = new Map<string, { qty: number; amount?: number; plain: boolean }>();
  for (const l of input) {
    if (!Number.isFinite(l.qty) || l.qty < 0) throw new OrderError("qty");
    const hasAmt = l.amount !== undefined && l.amount !== null;
    if (hasAmt && !validAmount(l.amount!)) throw new OrderError("qty");
    if (l.qty === 0 && !hasAmt) continue;
    const m = merged.get(l.productId) ?? { qty: 0, plain: false };
    m.qty = round2(m.qty + l.qty);
    if (hasAmt) m.amount = round2((m.amount ?? 0) + l.amount!);
    else m.plain = true;
    merged.set(l.productId, m);
  }
  const out: BasketLine[] = [];
  for (const [id, m] of merged) {
    const p = await db.products.get(id);
    if (!p || p.shopId !== shopId) throw new OrderError("notFound");
    // By amount only for loose goods, and only when the whole line was asked that way.
    const fromAmt = m.amount !== undefined && !m.plain ? qtyForAmount(m.amount, p) : null;
    if (m.amount !== undefined && !m.plain && fromAmt === null) throw new OrderError("qty");
    const qty = fromAmt ?? m.qty;
    if (!validQty(qty, p.unit)) throw new OrderError("qty");
    out.push(lineOf(p, qty, fromAmt !== null ? m.amount : undefined));
  }
  if (!out.length) throw new OrderError("lines");
  return out;
}

async function customerOf(shopId: string, customerId: string): Promise<Customer> {
  const c = await db.customers.get(customerId);
  if (!c || c.shopId !== shopId) throw new OrderError("customer");
  return c;
}

/** Create or edit a basket (name + lines with quantities). */
export async function saveBasket(input: { id?: string; shopId: string; customerId: string; name: string; lines: LineInput[]; fromSaleId?: string }): Promise<Basket> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw new OrderError("name");
  return db.transaction("rw", ALL(), async () => {
    await customerOf(input.shopId, input.customerId);
    const lines = await cleanLines(input.shopId, input.lines);
    const now = Date.now();
    const cur = input.id ? await db.baskets.get(input.id) : undefined;
    if (input.id && (!cur || cur.shopId !== input.shopId || cur.deletedAt)) throw new OrderError("notFound");
    const b: Basket = cur
      ? { ...cur, name, lines, customerId: input.customerId, updatedAt: Math.max(now, cur.updatedAt + 1) }
      : { id: uuid(), shopId: input.shopId, customerId: input.customerId, name, lines, createdAt: now, updatedAt: now };
    if (!cur && input.fromSaleId) b.fromSaleId = input.fromSaleId;
    await db.baskets.put(b);
    await enqueue("baskets", "upsert", b.id, b);
    return b;
  });
}

/** Remove a basket (kept as a synced tombstone so other phones remove it too). */
export async function deleteBasket(id: string) {
  await db.transaction("rw", ALL(), async () => {
    const b = await db.baskets.get(id);
    if (!b || b.deletedAt) return;
    const now = Date.now();
    const next: Basket = { ...b, deletedAt: now, updatedAt: Math.max(now, b.updatedAt + 1) };
    await db.baskets.put(next);
    await enqueue("baskets", "upsert", id, next);
  });
}

/** "Save as basket" from a past bill: what is still on it (returns left out), for its customer. */
export async function basketFromSale(saleId: string, name: string, customerId?: string): Promise<Basket> {
  const s = await db.sales.get(saleId);
  if (!s) throw new OrderError("notFound");
  const cid = s.customerId ?? customerId;
  if (!cid) throw new OrderError("customer");
  // An amount line nothing was returned from stays "₹20 की चीनी" in the basket.
  const lines: LineInput[] = s.items
    .map((it) => ({ productId: it.productId, qty: remainingQty(it), ...(it.amount !== undefined && !(it.returnedQty ?? 0) ? { amount: it.amount } : {}) }))
    .filter((l) => l.qty > 0);
  const known = [];
  for (const l of lines) if (await db.products.get(l.productId)) known.push(l);
  if (!known.length) throw new OrderError("lines");
  return saveBasket({ shopId: s.shopId, customerId: cid, name, lines: known, fromSaleId: s.id });
}

export const liveBaskets = (rows: Basket[]) => rows.filter((b) => !b.deletedAt).sort((a, b) => a.name.localeCompare(b.name));

/* ------------------------------ repeat ------------------------------ */

/** The customer's latest bill that still has something on it. */
export async function lastBillOf(customerId: string): Promise<Sale | undefined> {
  const bills = await db.sales.where("customerId").equals(customerId).toArray();
  return bills.filter((s) => saleStatus(s) !== "cancelled" && s.items.some((it) => remainingQty(it) > 0)).sort((a, b) => b.createdAt - a.createdAt)[0];
}

export interface RepeatLine {
  product: Product;
  qty: number;
  /** Loose line bought by amount: repeated as the same ₹ amount (qty at today's price). */
  amount?: number;
  /** Price on the basket / old bill (undefined = not known). */
  oldPrice?: number;
  priceChanged: boolean;
  /** Item-4 rules: more than the stock on record (sold anyway, shortage shown). */
  short: boolean;
  out: boolean;
}
export interface RepeatPlan {
  kind: "basket" | "bill";
  label: string;
  customerId: string;
  basketId?: string;
  saleId?: string;
  lines: RepeatLine[];
  /** Items whose product no longer exists (cannot be added). */
  missing: string[];
}

/** What repeating a basket or a customer's last bill puts on a new bill, at today's prices. */
export async function planRepeat(shopId: string, src: { basketId: string } | { customerId: string }, locale: Locale = "hi"): Promise<RepeatPlan> {
  let kind: RepeatPlan["kind"];
  let customerId: string;
  let label: string;
  let wanted: { productId: string; qty: number; price?: number; nameHi: string; nameEn: string; amount?: number }[];
  let basketId: string | undefined;
  let saleId: string | undefined;
  if ("basketId" in src) {
    const b = await db.baskets.get(src.basketId);
    if (!b || b.shopId !== shopId || b.deletedAt) throw new OrderError("notFound");
    kind = "basket";
    customerId = b.customerId;
    label = b.name;
    basketId = b.id;
    wanted = b.lines;
  } else {
    const s = await lastBillOf(src.customerId);
    if (!s || s.shopId !== shopId) throw new OrderError("noBill");
    kind = "bill";
    customerId = src.customerId;
    label = fmtDate(s.createdAt, locale, "d MMM");
    saleId = s.id;
    wanted = s.items
      .map((it) => ({ productId: it.productId, qty: remainingQty(it), price: it.price, nameHi: it.nameHi, nameEn: it.nameEn, ...(it.amount !== undefined && !(it.returnedQty ?? 0) ? { amount: it.amount } : {}) }))
      .filter((l) => l.qty > 0);
  }
  const lines: RepeatLine[] = [];
  const missing: string[] = [];
  const qty = new Map<string, number>();
  for (const w of wanted) qty.set(w.productId, round2((qty.get(w.productId) ?? 0) + w.qty));
  // Same product twice: amounts only add up when every line of it was by amount.
  const amt = new Map<string, number | null>();
  for (const w of wanted) {
    const cur = amt.get(w.productId);
    amt.set(w.productId, w.amount === undefined || cur === null ? null : round2((cur ?? 0) + w.amount));
  }
  const seen = new Set<string>();
  for (const w of wanted) {
    if (seen.has(w.productId)) continue;
    seen.add(w.productId);
    const p = await db.products.get(w.productId);
    if (!p || p.shopId !== shopId) {
      missing.push(names(w, locale).primary);
      continue;
    }
    const a = amt.get(w.productId) ?? null;
    const fromAmt = a !== null ? qtyForAmount(a, p) : null;
    const q = fromAmt ?? qty.get(w.productId)!;
    if (!validQtyFor(q, p.unit)) continue; // e.g. a loose item that became a pack: can't repeat 0.5 of a pack
    lines.push({ product: p, qty: q, ...(fromAmt !== null ? { amount: a! } : {}), oldPrice: w.price, priceChanged: w.price !== undefined && round2(w.price) !== round2(p.sellPrice), short: q > Math.max(0, p.qty), out: p.qty <= 0 });
  }
  return { kind, label, customerId, basketId, saleId, lines, missing };
}

/** Put a repeat plan into the sale cart (replaces the current cart; checkout stays the normal one). */
export async function loadRepeatIntoCart(shopId: string, plan: RepeatPlan) {
  const repeat: RepeatInfo = {
    kind: plan.kind,
    label: plan.label,
    customerId: plan.customerId,
    prices: Object.fromEntries(plan.lines.filter((l) => l.oldPrice !== undefined).map((l) => [l.product.id, l.oldPrice!])),
    missing: plan.missing,
  };
  await db.saleDrafts.put({
    shopId,
    id: uuid(),
    cart: Object.fromEntries(plan.lines.map((l) => [l.product.id, l.qty])),
    amounts: Object.fromEntries(plan.lines.filter((l) => l.amount !== undefined).map((l) => [l.product.id, l.amount!])),
    payment: "cash",
    customerId: plan.customerId,
    newCust: null,
    repeat,
  });
}

/* ------------------------------ orders ------------------------------ */

export async function createOrder(input: {
  shopId: string;
  customerId?: string;
  newCustomer?: { name: string; phone?: string; address?: string; landmark?: string };
  lines: LineInput[];
  source: OrderSource;
  basketId?: string;
  text?: string;
  unmatched?: string[];
  billAt: BillAt;
  note?: string;
  byName?: string;
}): Promise<CustomerOrder> {
  if (input.billAt !== "packed" && input.billAt !== "delivery") throw new OrderError("status");
  return db.transaction("rw", ALL(), async () => {
    const snap = await cleanLines(input.shopId, input.lines);
    let customerId = input.customerId;
    if (!customerId && input.newCustomer?.name.trim()) {
      customerId = (await addCustomer(input.shopId, input.newCustomer.name, input.newCustomer.phone, input.newCustomer)).id;
    }
    if (!customerId) throw new OrderError("customer");
    await customerOf(input.shopId, customerId);
    const now = Date.now();
    const lines: CustomerOrderLine[] = snap.map((l) => ({ productId: l.productId, nameHi: l.nameHi, nameEn: l.nameEn, unit: l.unit, qty: l.qty, price: l.price ?? 0, ...(l.amount !== undefined ? { amount: l.amount } : {}) }));
    const o: CustomerOrder = { id: uuid(), shopId: input.shopId, customerId, lines, source: input.source, billAt: input.billAt, createdAt: now, updatedAt: now };
    if (input.basketId) o.basketId = input.basketId;
    const text = input.text?.trim().slice(0, 4000);
    if (text) o.text = text;
    const unmatched = (input.unmatched ?? []).map((u) => u.trim()).filter(Boolean).slice(0, 50);
    if (unmatched.length) o.unmatched = unmatched;
    const note = input.note?.trim().slice(0, 300);
    if (note) o.note = note;
    if (input.byName) o.byName = input.byName;
    await db.customerOrders.add(o);
    await enqueue("customer_orders", "upsert", o.id, o);
    await addEvent({ id: `${o.id}-new`, shopId: o.shopId, orderId: o.id, type: "status", status: "new", byName: input.byName, createdAt: now });
    return o;
  });
}

async function addEvent(e: OrderEvent) {
  if (await db.orderEvents.get(e.id)) return;
  for (const k of Object.keys(e) as (keyof OrderEvent)[]) if (e[k] === undefined) delete e[k];
  await db.orderEvents.add(e);
  await enqueue("order_events", "upsert", e.id, e);
}

export async function stateOf(orderId: string): Promise<OrderState> {
  const events = await db.orderEvents.where("orderId").equals(orderId).toArray();
  return orderState(events, !!(await db.sales.get(orderBillId(orderId))), orderId);
}

/**
 * Packing checklist: tick a line and / or change the packed quantity (0 = not available). Locked
 * once the order is billed or closed.
 */
export async function setPacking(orderId: string, index: number, change: { packed?: boolean; packedQty?: number | null }) {
  return db.transaction("rw", ALL(), async () => {
    const o = await db.customerOrders.get(orderId);
    if (!o) throw new OrderError("notFound");
    const st = await stateOf(orderId);
    if (st.saleId) throw new OrderError("billed");
    if (!(st.status === "new" || st.status === "packing")) throw new OrderError("status");
    const line = o.lines[index];
    if (!line) throw new OrderError("notFound");
    const next = { ...line };
    if (change.packed !== undefined) next.packed = change.packed;
    if (change.packedQty !== undefined) {
      if (change.packedQty === null) delete next.packedQty;
      else {
        const q = round2(change.packedQty);
        if (!validQty(q, line.unit, true)) throw new OrderError("qty");
        next.packedQty = q;
        // Packed a different weight than the ₹ amount gave: the bill goes by the packed weight.
        if (q !== line.qty) delete next.amount;
      }
    }
    if (!next.packed) delete next.packed;
    const lines = o.lines.map((l, i) => (i === index ? next : l));
    const now = Date.now();
    const row: CustomerOrder = { ...o, lines, updatedAt: Math.max(now, o.updatedAt + 1) };
    await db.customerOrders.put(row);
    await enqueue("customer_orders", "upsert", o.id, row);
    return row;
  });
}

/**
 * Move an order to its next status. When this step is the order's billing point (see billsOn) and
 * there is no bill yet, `pay` is required and the bill is made in the same transaction – with the
 * normal sale rules (current prices, shortages recorded but never blocking, udhaar to the customer).
 * Repeating the call never bills twice.
 */
export async function setOrderStatus(opts: {
  orderId: string;
  to: OrderStatus;
  pay?: { payment: PaymentType; payments?: PaymentRequest[] };
  byName?: string;
  note?: string;
}): Promise<{ state: OrderState; sale?: Sale }> {
  return db.transaction("rw", ALL(), async () => {
    const o = await db.customerOrders.get(opts.orderId);
    if (!o) throw new OrderError("notFound");
    const st = await stateOf(o.id);
    if (st.status === opts.to) return { state: st, sale: st.saleId ? await db.sales.get(st.saleId) : undefined };
    if (opts.to === "cancelled") {
      if (st.saleId) throw new OrderError("billed");
      if (!isPending(st.status)) throw new OrderError("status");
    } else if (!canMove(st.status, opts.to)) throw new OrderError("status");
    const now = Date.now();
    let sale: Sale | undefined;
    if (billsOn(o.billAt, opts.to) && !st.saleId) {
      if (!opts.pay) throw new OrderError("payment");
      const lines: CartLine[] = [];
      for (const l of o.lines) {
        const q = billQty(l);
        if (q <= 0) continue;
        const p = await db.products.get(l.productId);
        const amount = billAmount(l);
        // By amount: the bill is for that ₹ amount, qty derived again at the billing price.
        if (p) lines.push({ product: p, qty: q, ...(amount !== undefined && qtyForAmount(amount, p) !== null ? { amount } : {}) });
      }
      if (!lines.length) throw new OrderError("empty");
      const id = orderBillId(o.id);
      sale = await recordSale({ shopId: o.shopId, lines, payment: opts.pay.payment, payments: opts.pay.payments, customerId: o.customerId, draftId: id, orderId: o.id });
      await addEvent({ id: `${o.id}-billed`, shopId: o.shopId, orderId: o.id, type: "bill", saleId: sale.id, byName: opts.byName, createdAt: now });
    }
    await addEvent({ id: uuid(), shopId: o.shopId, orderId: o.id, type: "status", status: opts.to, note: opts.note?.trim() || undefined, byName: opts.byName, createdAt: now });
    return { state: await stateOf(o.id), sale };
  });
}

/** Lines for the bill at today's prices (shown before billing). */
export function billPreview(o: CustomerOrder, byId: Map<string, Product>) {
  const lines = o.lines
    .map((l) => {
      const product = byId.get(l.productId);
      const amount = billAmount(l);
      const fromAmt = product && amount !== undefined ? qtyForAmount(amount, product) : null;
      return { line: l, product, qty: fromAmt ?? billQty(l), amount: fromAmt !== null ? amount : undefined };
    })
    .filter((x): x is { line: CustomerOrderLine; product: Product; qty: number; amount: number | undefined } => !!x.product && x.qty > 0);
  return { lines, total: round2(lines.reduce((a, x) => a + (x.amount ?? x.qty * x.product.sellPrice), 0)) };
}

/* ------------------------------ loading ------------------------------ */

export interface OrderRow {
  order: CustomerOrder;
  state: OrderState;
  customer?: Customer;
  sale?: Sale;
}

export async function loadOrders(shopId: string): Promise<OrderRow[]> {
  const [orders, events, customers] = await Promise.all([
    db.customerOrders.where("shopId").equals(shopId).toArray(),
    db.orderEvents.where("shopId").equals(shopId).toArray(),
    db.customers.where("shopId").equals(shopId).toArray(),
  ]);
  const byOrder = new Map<string, OrderEvent[]>();
  for (const e of events) byOrder.set(e.orderId, [...(byOrder.get(e.orderId) ?? []), e]);
  const custs = new Map(customers.map((c) => [c.id, c]));
  const sales = await db.sales.bulkGet(orders.map((o) => orderBillId(o.id)));
  return orders
    .map((o, i) => ({ order: o, state: orderState(byOrder.get(o.id) ?? [], !!sales[i], o.id), customer: custs.get(o.customerId), sale: sales[i] ?? undefined }))
    .sort((a, b) => b.order.createdAt - a.order.createdAt);
}

/** Home line: pending orders, and how many of them came in today. */
export async function orderCounts(shopId: string, now: number) {
  const rows = await loadOrders(shopId);
  const pending = rows.filter((r) => isPending(r.state.status));
  const today = dayKey(now);
  return { pending: pending.length, today: pending.filter((r) => dayKey(r.order.createdAt) === today).length, ready: pending.filter((r) => r.state.status === "ready").length };
}

/* ------------------------------ WhatsApp texts ------------------------------ */

const itemLine = (t: T, n: number, l: { nameHi: string; nameEn: string; unit: Unit; amount?: number }, qty: number, locale: Locale) =>
  l.amount !== undefined
    ? t("orders.waLineAmount", { n, name: names(l, locale).primary, amount: formatINR(l.amount), qty: formatNum(qty), unit: t(`unit.${l.unit}`) })
    : t("orders.waLine", { n, name: names(l, locale).primary, qty: formatNum(qty), unit: t(`unit.${l.unit}`) });

/** Order confirmation with the (approximate) total. */
export function confirmText(t: T, o: CustomerOrder, c: Pick<Customer, "name">, shop: Pick<Shop, "name">, total: number, locale: Locale) {
  return [
    t("orders.waHello", { name: c.name }),
    t("orders.waGot", { shop: shop.name, no: orderNo(o) }),
    "",
    ...o.lines.map((l, i) => itemLine(t, i + 1, l, l.qty, locale)),
    "",
    t("orders.waTotal", { amount: formatINR(total) }),
    t("orders.waNext"),
    "— " + shop.name,
  ].join("\n");
}

export function statusText(t: T, kind: "ready" | "out", o: CustomerOrder, c: Pick<Customer, "name">, shop: Pick<Shop, "name">, total: number) {
  return t(kind === "ready" ? "orders.waReady" : "orders.waOut", { name: c.name, no: orderNo(o), count: o.lines.filter((l) => billQty(l) > 0).length, amount: formatINR(total), shop: shop.name });
}

/** Packing list to share (e.g. with the delivery boy): quantities to pack, address and landmark. */
export function packingText(t: T, o: CustomerOrder, c: Pick<Customer, "name" | "phone" | "address" | "landmark">, locale: Locale) {
  return [
    t("orders.packTitle", { no: orderNo(o), name: c.name }),
    "",
    ...o.lines.map((l) => t(l.packed ? "orders.packLineDone" : "orders.packLine", { name: names(l, locale).primary, qty: formatNum(billQty(l)), unit: t(`unit.${l.unit}`) })),
    ...(o.unmatched?.length ? ["", t("orders.packUnmatched", { lines: o.unmatched.join(", ") })] : []),
    "",
    ...(c.phone ? [t("orders.packPhone", { phone: c.phone })] : []),
    ...(c.address ? [t("orders.packAddress", { address: c.address })] : []),
    ...(c.landmark ? [t("orders.packLandmark", { landmark: c.landmark })] : []),
  ].join("\n").trim();
}

/* ------------------------------ CSV ------------------------------ */

const itemsText = (lines: { nameEn: string; nameHi: string; unit: Unit; qty: number; amount?: number }[]) =>
  lines.map((l) => `${l.nameEn || l.nameHi} ${formatNum(l.qty)} ${l.unit}${l.amount !== undefined ? ` (Rs ${formatNum(l.amount)})` : ""}`).join("; ");

export const ORDERS_CSV_HEADERS = ["date", "time", "order_no", "customer", "phone", "status", "bill_at", "source", "items", "packed", "estimate", "bill_no", "bill_total", "unmatched", "by"];
export function ordersCSVRows(rows: OrderRow[]) {
  return rows.map(({ order: o, state, customer, sale }) => [
    fmtDate(o.createdAt, "en", "yyyy-MM-dd"),
    fmtDate(o.createdAt, "en", "HH:mm"),
    orderNo(o),
    customer?.name ?? "",
    customer?.phone ?? "",
    state.status,
    o.billAt,
    o.source,
    itemsText(o.lines),
    o.lines.some((l) => l.packed || l.packedQty !== undefined) ? itemsText(o.lines.map((l) => ({ ...l, qty: billQty(l) }))) : "",
    orderTotal(o),
    sale ? sale.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 6).toUpperCase() : "",
    sale ? netTotal(sale) : "",
    (o.unmatched ?? []).join(" | "),
    o.byName ?? "",
  ]);
}

export const BASKETS_CSV_HEADERS = ["customer", "phone", "basket", "items", "item_count", "estimate", "updated"];
export function basketsCSVRows(baskets: Basket[], customers: Map<string, Customer>, byId: Map<string, Product>) {
  return liveBaskets(baskets).map((b) => [
    customers.get(b.customerId)?.name ?? "",
    customers.get(b.customerId)?.phone ?? "",
    b.name,
    itemsText(b.lines),
    b.lines.length,
    round2(b.lines.reduce((a, l) => a + (l.amount ?? l.qty * (byId.get(l.productId)?.sellPrice ?? l.price ?? 0)), 0)),
    fmtDate(b.updatedAt, "en", "yyyy-MM-dd"),
  ]);
}
