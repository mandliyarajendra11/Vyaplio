import Dexie, { type EntityTable } from "dexie";
import { planSuppliers } from "./supplierMigrate";
import { kindForUnit, type ProductKind } from "./units";

export type Locale = "hi" | "en";
export type Unit = "pcs" | "kg" | "ltr" | "pkt" | "box";
export const UNITS: Unit[] = ["pcs", "kg", "ltr", "pkt", "box"];
export type PaymentType = "cash" | "upi" | "credit";
/** A method of one payment part (same three as PaymentType). */
export type PayMethod = PaymentType;
/** Bill-level label: the single method, or "split" when several methods paid one bill. */
export type SalePaymentKind = PaymentType | "split";

/** One part of a bill's payment. Cash parts may record the note handed over and the change. */
export interface SalePayment {
  method: PayMethod;
  amount: number;
  /** UPI only: "pending" until the shopkeeper confirms the money arrived. Others are always "paid". */
  status?: "paid" | "pending";
  tendered?: number;
  change?: number;
  /** UPI: optional UTR / last digits noted at confirmation. */
  ref?: string;
  confirmedAt?: number;
  /** Set when a pending UPI part was settled as cash or udhaar instead. */
  convertedFrom?: "upi";
}

export interface User {
  id: string;
  email: string;
  passHash: string;
  /** The person's own name for "who did this" (set during setup; older accounts fall back to the shop's owner name). */
  displayName?: string;
  createdAt: number;
}

export interface Shop {
  id: string;
  ownerId: string;
  name: string;
  ownerName: string;
  phone?: string;
  upiId?: string;
  language: Locale;
  deadStockDays: number;
  expiryWarnDays: number;
  isDemo?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Product {
  id: string;
  shopId: string;
  nameHi: string;
  nameEn: string;
  barcode?: string;
  unit: Unit;
  qty: number;
  /** 0 = not entered yet (unknown), never "free": profit reports leave such sales out and say so. */
  buyPrice: number;
  /** When the buy price was last entered or changed (ms). Missing on older rows: updatedAt is the best guess. */
  buyPriceAt?: number;
  sellPrice: number;
  lowStockAt: number;
  expiryDate?: string; // yyyy-MM-dd
  /** Free-text supplier name (kept as typed; older rows only have this). */
  supplier?: string;
  /** Supplier diary record (item 12). Older rows: matched by name (see suppliers.ts). */
  supplierId?: string;
  /** Order up to this quantity when reordering (suggested order = reorderTo − stock). Missing = 2 × low-stock level. */
  reorderTo?: number;
  /** The shop's own extra names for search ("shakkar", "Tata salt"); built-in aliases are added automatically. */
  aliases?: string[];
  /**
   * Sealed pack (whole numbers: pcs / pkt / box) or loose (by weight / volume: kg / ltr, price per kg / L).
   * Always matches the unit; missing on older rows = read from the unit (see units.ts kindOf).
   */
  kind?: ProductKind;
  /** Loose only: the + / − step and stock-screen step in the base unit (0.1 = 100 g … 1 = 1 kg). Missing = 1. */
  step?: number;
  /** Packed only: printed MRP (₹ per piece / packet). */
  mrp?: number;
  /** Packed only: the loose product this pack is opened into (e.g. 1 kg sealed atta → loose atta). */
  looseId?: string;
  /** Packed only: how much loose stock one pack gives, in the loose product's unit (1 = 1 kg). */
  packSize?: number;
  lastSoldAt?: number;
  salesCount: number;
  createdAt: number;
  /** Last edit of the product's details. Stock changes do not bump it (stock = sum of moves). */
  updatedAt: number;
  /** Only on sync tombstones (product deleted); never stored locally. */
  deletedAt?: number;
}

export interface Customer {
  id: string;
  shopId: string;
  name: string;
  phone?: string;
  /** Delivery details (item 13): where to bring a WhatsApp order and a landmark to find it. */
  address?: string;
  landmark?: string;
  balance: number; // positive = customer owes the shop
  lastPaidAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SaleItem {
  /** Total item + allocated bill discount for this entire line. Original price/amount remain intact. */
  discount?: number;
  /** Item-specific portion of discount; informational breakdown. Never subtract it a second time. */
  itemDiscount?: number;
  /** This line's share of an optional whole-rupee bill round-off, signed in rupees. */
  rounding?: number;
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: Unit;
  qty: number;
  price: number;
  /** Buy price per unit at sale time (snapshot). 0 when it was not known. */
  cost: number;
  /**
   * Whether `cost` is a real buy price. Missing on lines from before honest profit reports: then a
   * cost of 0 means "unknown" (no buy price had been entered), never "free" – see costKnown().
   */
  costKnown?: boolean;
  /** When that buy price had been entered (for "old buy price" checks). */
  costAt?: number;
  /** The cost was added later from "add buy price" (an estimate: today's price used for an older bill). */
  costFilled?: boolean;
  /** Quantity of this line already returned (cumulative). */
  returnedQty?: number;
  /**
   * Sold by amount ("₹20 का सामान", loose only): original line amount before any discounts.
   * qty = amount / price rounded to 10 g / 10 ml; discounts reduce money, never this derived quantity.
   */
  amount?: number;
}

/** undefined on old rows = "active". */
export type SaleStatus = "active" | "partially_returned" | "cancelled";
export type RefundMethod = PaymentType; // cash / upi refund, or "credit" = reduce udhaar
/** Where a refund went: a method, or "upiPending" = the unconfirmed UPI part was reduced (no money moved). */
export type RefundBucket = RefundMethod | "upiPending";
export interface RefundPart {
  method: RefundBucket;
  amount: number;
}

export interface Sale {
  id: string;
  shopId: string;
  items: SaleItem[];
  total: number;
  cost: number;
  /** The single method, or "split". Read the parts with paymentsOf(), never this alone. */
  payment: SalePaymentKind;
  /** v5+: the parts that paid this bill (sum = total). Missing on pre-v5 rows = one part of `payment`. */
  payments?: SalePayment[];
  /** Required when a credit (udhaar) part exists. */
  customerId?: string;
  createdAt: number;
  day: string; // yyyy-MM-dd (local)
  /** undefined = "active" (bills created before corrections existed). */
  status?: SaleStatus;
  /** Cumulative value / cost of goods returned or cancelled on this bill. */
  returnedTotal?: number;
  returnedCost?: number;
  /** The customer order this bill came from (item 13). */
  orderId?: string;
  updatedAt?: number;
}

/** One line of a correction; `index` points at Sale.items[index]. */
export interface CorrectionLine {
  index: number;
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: Unit;
  qty: number;
  price: number;
  cost: number;
  /** Copied from the bill line (missing on old corrections: cost 0 = unknown). */
  costKnown?: boolean;
  /** Amount-based bill line: the money value of this returned part (pro rata of the amount paid). */
  amount?: number;
}

/** Append-only record of a return / cancellation. Never edited or deleted. */
export interface SaleCorrection {
  id: string;
  shopId: string;
  saleId: string;
  type: "return" | "cancel";
  reason: string;
  lines: CorrectionLine[];
  amount: number; // value refunded / udhaar reduced
  cost: number; // cost of goods returned to stock
  /** The route the shopkeeper chose. */
  refundMethod: RefundMethod;
  /** v5+: how the amount was actually split across methods (sum = amount). Missing = all refundMethod. */
  refunds?: RefundPart[];
  /** The shopkeeper chose to refund cash/UPI beyond what that method brought in (warning confirmed). */
  crossMethod?: boolean;
  customerId?: string;
  byUserId?: string;
  byName?: string;
  createdAt: number;
  day: string; // day the correction happened (counts against that day's money)
}

export interface SaleDraft {
  /** Per-product discount for the entire selected quantity (not per unit). */
  itemDiscounts?: Record<string, { kind: "amount" | "percent"; value: string }>;
  roundToRupee?: boolean;
  /** Whole-bill discount input, persisted even while invalid so reloading never silently changes it. */
  discount?: { kind: "amount" | "percent"; value: string } | null;
  shopId: string;
  id: string;
  cart: Record<string, number>;
  payment: PaymentType;
  customerId: string;
  newCust: { name: string; phone: string } | null;
  /** Split mode: typed amounts per method ("" = auto-fill the remainder). */
  split?: Partial<Record<PaymentType, string>> | null;
  /** The cart was loaded from a saved basket or "repeat last bill": what to flag at checkout. */
  repeat?: RepeatInfo | null;
  /** Loose lines sold by amount: productId → ₹ (cart holds the derived qty). */
  amounts?: Record<string, number> | null;
}

/** Remembered with a repeated cart: the old prices (to flag changes) and items no longer sold. */
export interface RepeatInfo {
  kind: "basket" | "bill";
  label: string;
  customerId: string;
  /** productId -> price on the basket / old bill. */
  prices: Record<string, number>;
  /** Names of items that could not be added (product deleted). */
  missing: string[];
}

export interface LedgerEntry {
  id: string;
  shopId: string;
  customerId: string;
  type: "debit" | "credit"; // debit = gave on credit, credit = payment received
  amount: number;
  note?: string;
  saleId?: string;
  /** "return" = udhaar reduced because goods came back / bill cancelled (not a payment). */
  kind?: "return";
  /** Payments received (type "credit", not returns): how the money came. Missing on old rows = cash. */
  method?: "cash" | "upi";
  correctionId?: string;
  createdAt: number;
}

/**
 * Every change to a product's quantity, append-only. Stock = sum of moves, so changes made on
 * two phones merge exactly (no "last write wins" on a number). "opening" = starting quantity.
 * Stock may go below zero: a sale is never blocked or clamped; the shortage stays visible until counted.
 */
export interface StockMove {
  id: string;
  shopId: string;
  productId: string;
  delta: number;
  reason: StockMoveReason;
  refId?: string; // sale / correction id
  /** Sale only: how much more was sold than this phone had on record (stock went below zero). */
  shortBy?: number;
  /** "count" only: the quantity the shopkeeper counted. */
  counted?: number;
  /** "damage" / "theft": buy price per unit at that moment, so the loss is valued at cost. */
  unitCost?: number;
  note?: string;
  createdAt: number;
}

/** Reasons the shopkeeper can give for a stock correction (never a silent overwrite). */
export const ADJUST_REASONS = ["count", "damage", "theft", "purchase"] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];
/** "adjust" = quick ± on the stock screen; "edit" = legacy product-form quantity change. */
/** "purchase" also = a purchase bill (refId = purchase id); "supplierReturn" = goods sent back to a supplier. */
/** "openPack" = sealed packs opened into loose stock: one move out of the pack product, one into the loose product (same refId). */
export const STOCK_MOVE_REASONS = ["opening", "sale", "return", "adjust", "edit", ...ADJUST_REASONS, "supplierReturn", "openPack"] as const;
export type StockMoveReason = (typeof STOCK_MOVE_REASONS)[number];

/**
 * Cash drawer (गल्ला) entries, append-only. Expected cash for a day = opening + cash in − cash out;
 * bill cash, cash refunds and udhaar cash collections come from the bills / ledger automatically.
 *  - opening: the day's opening cash when it differs from the carried closing count (reason)
 *  - added: cash put into the drawer · expense / supplier / withdrawal / bank: cash taken out
 *  - void: cancels an earlier entry (voidsId) with a reason – nothing is ever edited or deleted
 *  - close: the count that closes the day (amount = counted); a later close corrects it (reason)
 */
export const CASH_KINDS = ["opening", "added", "expense", "supplier", "withdrawal", "bank", "void", "close"] as const;
export type CashKind = (typeof CASH_KINDS)[number];
/** Entries the shopkeeper adds by hand (in or out of the drawer). */
export const CASH_MANUAL_KINDS = ["expense", "supplier", "withdrawal", "added", "bank"] as const;
export type CashManualKind = (typeof CASH_MANUAL_KINDS)[number];
export const CASH_OUT_KINDS: readonly CashKind[] = ["expense", "supplier", "withdrawal", "bank"];
/** Expense categories (kept stable: profit-after-expenses reports group by them). */
export const EXPENSE_CATEGORIES = ["rent", "electricity", "salary", "transport", "tea", "packaging", "repair", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
/** Notes counted at closing; coins are entered as one rupee amount. */
export const DENOMS = [2000, 500, 200, 100, 50, 20, 10] as const;

export interface CashEntry {
  id: string;
  shopId: string;
  /** The business day (yyyy-MM-dd) the entry belongs to. */
  day: string;
  kind: CashKind;
  /** Rupees, never negative. close = counted cash; opening = opening cash; void = the voided amount (info). */
  amount: number;
  category?: ExpenseCategory;
  note?: string;
  /** Supplier payments: free-text name now; supplierId links to the supplier diary later. */
  supplierId?: string;
  supplierName?: string;
  /** Why: opening changed, entry voided, count difference, or a change made after the day was closed. */
  reason?: string;
  voidsId?: string;
  /** close only: expected cash at that moment, counted − expected, and the count per note. */
  expected?: number;
  diff?: number;
  denoms?: Record<string, number>;
  /** Added while the day was already closed (a logged correction). */
  afterClose?: boolean;
  byName?: string;
  createdAt: number;
}

/* ------------------------------ supplier diary (item 12) ------------------------------ */

/** A supplier. Outstanding balance is never stored: it is the sum of the append-only supplier ledger. */
export interface Supplier {
  id: string;
  shopId: string;
  name: string;
  phone?: string;
  /** What they supply (free text, e.g. "आटा, दाल"). */
  items?: string;
  /** Credit days: a purchase on credit is due this many days after the bill date. Missing = no due date. */
  termsDays?: number;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PurchaseLine {
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: Unit;
  qty: number;
  /** Buy price per unit on this bill. */
  buyPrice: number;
  /** The product's buy price before this bill (only when the bill changed it). */
  prevBuyPrice?: number;
  /** Packed only (optional): expiry date of this batch (yyyy-MM-dd). */
  expiryDate?: string;
}

/** A supplier's bill (append-only: a mistake is fixed with a return / adjustment in the ledger). */
export interface Purchase {
  id: string;
  shopId: string;
  supplierId: string;
  /** Bill date (yyyy-MM-dd). */
  day: string;
  billNo?: string;
  lines: PurchaseLine[];
  total: number;
  /** Paid at the time of the bill. */
  paidCash: number;
  paidUpi: number;
  /** total − paidCash − paidUpi: goes into the supplier ledger as owed. */
  credit: number;
  /** Bill date + supplier's credit days (only when something is on credit and terms are known). */
  dueDate?: string;
  /** The WhatsApp order this bill received. */
  orderId?: string;
  note?: string;
  byName?: string;
  createdAt: number;
}

/**
 * Supplier ledger (append-only). Outstanding = Σ purchase − Σ payment − Σ return + Σ adjust.
 *  - purchase: the full bill total (payments made with the bill are separate "payment" rows)
 *  - payment: money given (cash also leaves the galla as a supplier entry; UPI does not)
 *  - return: goods sent back / debit note (reduces what we owe)
 *  - adjust: signed correction with a reason (discount, old balance, mistake)
 */
export const SUPPLIER_ENTRY_TYPES = ["purchase", "payment", "return", "adjust"] as const;
export type SupplierEntryType = (typeof SUPPLIER_ENTRY_TYPES)[number];
export interface SupplierEntry {
  id: string;
  shopId: string;
  supplierId: string;
  type: SupplierEntryType;
  /** Rupees. Positive, except "adjust" which may be negative (we owe less). */
  amount: number;
  /** Business day (yyyy-MM-dd). */
  day: string;
  method?: "cash" | "upi";
  purchaseId?: string;
  /** The galla entry created for a cash payment. */
  cashEntryId?: string;
  /** purchase rows: when the credit part is due. */
  dueDate?: string;
  billNo?: string;
  /** return / adjust: why (required). */
  reason?: string;
  note?: string;
  byName?: string;
  createdAt: number;
}

export interface OrderLine {
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: Unit;
  qty: number;
}

/** A WhatsApp order to a supplier. "ordered" → "received" (a purchase) or "cancelled". */
export interface PurchaseOrder {
  id: string;
  shopId: string;
  supplierId: string;
  lines: OrderLine[];
  status: "ordered" | "received" | "cancelled";
  purchaseId?: string;
  byName?: string;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------ repeat orders (item 13) ------------------------------ */

export interface BasketLine {
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: Unit;
  qty: number;
  /** Selling price when the basket was saved (to flag price changes on repeat). */
  price?: number;
  /** Loose only: bought by amount ("₹20 की चीनी"); qty is derived at today's price on repeat. */
  amount?: number;
}

/** A customer's saved household basket ("महीने का राशन"). Edited (last write wins); deletedAt = removed. */
export interface Basket {
  id: string;
  shopId: string;
  customerId: string;
  name: string;
  lines: BasketLine[];
  /** Made from this bill ("save as basket"). */
  fromSaleId?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * Customer order status. new → packing → ready → out (for delivery) → delivered, or
 * ready → picked (customer picked it up; done). cancelled from any status before it is billed.
 */
export const ORDER_STATUSES = ["new", "packing", "ready", "out", "picked", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** When the order becomes a bill (stock and money move only then). */
export type BillAt = "packed" | "delivery";
export const ORDER_SOURCES = ["paste", "basket", "repeat", "manual"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export interface CustomerOrderLine {
  productId: string;
  nameHi: string;
  nameEn: string;
  unit: Unit;
  /** Asked for. */
  qty: number;
  /** Selling price when the order was taken (the bill uses the price at billing time). */
  price: number;
  /** Loose only: asked by amount ("20 rupaye ki chini"); the bill derives qty at the billing price. */
  amount?: number;
  /** Packing checklist: ticked, and the quantity actually packed (missing = as asked). */
  packed?: boolean;
  packedQty?: number;
}

/**
 * An incoming customer order (not a bill). The row holds the lines and the packing checklist (last
 * write wins); the status is never stored here: it comes from the append-only order events.
 */
export interface CustomerOrder {
  id: string;
  shopId: string;
  customerId: string;
  lines: CustomerOrderLine[];
  source: OrderSource;
  basketId?: string;
  /** The pasted WhatsApp text (kept as received). */
  text?: string;
  /** Pasted lines no product was picked for (kept so nothing the customer asked for is lost). */
  unmatched?: string[];
  billAt: BillAt;
  note?: string;
  byName?: string;
  createdAt: number;
  updatedAt: number;
}

/** Append-only order history: status changes and the one bill it turned into. */
export interface OrderEvent {
  id: string;
  shopId: string;
  orderId: string;
  type: "status" | "bill";
  status?: OrderStatus;
  saleId?: string;
  note?: string;
  byName?: string;
  createdAt: number;
}

export type SyncTable =
  | "shops"
  | "products"
  | "customers"
  | "sales"
  | "credit_ledger"
  | "sale_corrections"
  | "stock_moves"
  | "cash_entries"
  | "suppliers"
  | "purchases"
  | "supplier_ledger"
  | "purchase_orders"
  | "baskets"
  | "customer_orders"
  | "order_events";

/**
 * Pending change for cloud sync. Removed only after the server confirmed the row.
 * `op: "delete"` is legacy (pre-v4); deletions are now synced as tombstones (deletedAt).
 */
export interface OutboxItem {
  seq?: number;
  table: SyncTable;
  op: "upsert" | "delete";
  rowId: string;
  shopId?: string;
  payload: unknown;
  createdAt: number;
  /** Legacy: set by the pre-v4 sync, which did not check the server's answer. */
  syncedAt?: number;
}

/** Small key/value store (cloud link, pull cursors, last sync result). */
export interface MetaRow {
  key: string;
  value: unknown;
}

export const db = new Dexie("dukaanmitra") as Dexie & {
  users: EntityTable<User, "id">;
  shops: EntityTable<Shop, "id">;
  products: EntityTable<Product, "id">;
  customers: EntityTable<Customer, "id">;
  sales: EntityTable<Sale, "id">;
  ledger: EntityTable<LedgerEntry, "id">;
  corrections: EntityTable<SaleCorrection, "id">;
  outbox: EntityTable<OutboxItem, "seq">;
  saleDrafts: EntityTable<SaleDraft, "shopId">;
  stockMoves: EntityTable<StockMove, "id">;
  meta: EntityTable<MetaRow, "key">;
  cashEntries: EntityTable<CashEntry, "id">;
  suppliers: EntityTable<Supplier, "id">;
  purchases: EntityTable<Purchase, "id">;
  supplierLedger: EntityTable<SupplierEntry, "id">;
  orders: EntityTable<PurchaseOrder, "id">;
  baskets: EntityTable<Basket, "id">;
  customerOrders: EntityTable<CustomerOrder, "id">;
  orderEvents: EntityTable<OrderEvent, "id">;
};

db.version(1).stores({
  users: "id, &email",
  shops: "id, ownerId",
  products: "id, shopId, barcode, updatedAt",
  customers: "id, shopId, updatedAt",
  sales: "id, shopId, day, createdAt, [shopId+day]",
  ledger: "id, shopId, customerId, createdAt",
  outbox: "++seq, table, createdAt",
});



db.version(2).stores({ saleDrafts: "shopId" });

// v3: bill cancellation / returns (append-only correction history).
db.version(3).stores({
  corrections: "id, shopId, saleId, createdAt, [shopId+day]",
});

// v4: cloud sync + backups. Stock becomes the sum of append-only moves; outbox rows know their shop.
db.version(4)
  .stores({
    outbox: "++seq, table, createdAt, shopId",
    stockMoves: "id, shopId, productId, createdAt",
    meta: "key",
  })
  .upgrade(async (tx) => {
    const now = Date.now();
    // Opening move = today's quantity, so sum(moves) == qty from the start.
    const products: Product[] = await tx.table("products").toArray();
    const moves: StockMove[] = products
      .filter((p) => p.qty !== 0)
      .map((p) => ({ id: `open-${p.id}`, shopId: p.shopId, productId: p.id, delta: p.qty, reason: "opening", createdAt: p.createdAt ?? now }));
    await tx.table("stockMoves").bulkPut(moves);
    const outbox = tx.table("outbox");
    await outbox.toCollection().modify((o: OutboxItem, ref: { value?: OutboxItem }) => {
      // Legacy deletes carry no payload/shop; nothing was ever confirmed by a server, so drop them.
      if (o.op === "delete") {
        delete ref.value;
        return;
      }
      const pl = (o.payload ?? {}) as { shopId?: string; id?: string };
      o.shopId = o.table === "shops" ? o.rowId : pl.shopId;
      delete o.syncedAt; // the old sync never verified the server's answer: send again (upserts are idempotent)
    });
  });

// v5: split payments. Old single-method bills get exactly one fully paid part (lossless: `payment` is kept).
db.version(5)
  .stores({})
  .upgrade(async (tx) => {
    await tx
      .table("sales")
      .toCollection()
      .modify((s: Sale) => {
        if (Array.isArray(s.payments) && s.payments.length) return;
        const method: PaymentType = s.payment === "upi" || s.payment === "credit" ? s.payment : "cash";
        s.payments = [{ method, amount: s.total, status: "paid" }];
      });
  });

// v6: daily cash closing (गल्ला), append-only drawer entries.
db.version(6).stores({ cashEntries: "id, shopId, day, [shopId+day], createdAt" });

// v7: older bills + search. Date ranges use the existing [shopId+day] index; a customer's bills
// (from the udhaar screen) use the new customerId index. Index-only change, no data rewritten.
db.version(7).stores({ sales: "id, shopId, day, createdAt, [shopId+day], customerId" });

// v8: supplier diary. Suppliers are created from the old free-text product supplier names and the
// galla's supplier payments (nothing is removed: the text stays on the rows). Ids are derived from
// the shop + name, so two phones that migrate on their own end up with the same supplier rows.
db.version(8)
  .stores({
    suppliers: "id, shopId",
    purchases: "id, shopId, supplierId, [shopId+day], createdAt",
    supplierLedger: "id, shopId, supplierId, createdAt",
    orders: "id, shopId, supplierId, createdAt",
  })
  .upgrade(async (tx) => {
    const now = Date.now();
    const products: Product[] = await tx.table("products").toArray();
    const cash: CashEntry[] = await tx.table("cashEntries").toArray();
    const existing: Supplier[] = await tx.table("suppliers").toArray();
    const plan = planSuppliers(products, cash, existing, now);
    for (const s of plan.created) {
      await tx.table("suppliers").put(s);
      await tx.table("outbox").add({ table: "suppliers", op: "upsert", rowId: s.id, shopId: s.shopId, payload: s, createdAt: now });
    }
    // Local link only (no new product version is uploaded): other phones link the same way by name.
    for (const [productId, supplierId] of plan.links) await tx.table("products").update(productId, { supplierId });
  });

// v9: WhatsApp repeat orders: saved baskets, customer orders and their append-only events. New tables
// only (customers gain optional address / landmark fields; nothing to rewrite).
db.version(9).stores({
  baskets: "id, shopId, customerId",
  customerOrders: "id, shopId, customerId, createdAt",
  orderEvents: "id, shopId, orderId, createdAt",
});
// v10 (item 14): every product gets its kind from its unit (kg / ltr → loose, pcs / pkt / box → packed).
// Stock, prices and updatedAt stay as they are; nothing is queued (other phones derive the same kind).
db.version(10)
  .stores({})
  .upgrade(async (tx) => {
    await tx
      .table("products")
      .toCollection()
      .modify((p: Product) => {
        if (!p.kind) p.kind = kindForUnit(p.unit);
      });
  });

/** Every table that holds shop data (for transactions that call several write helpers). */
export const shopTables = () => [
  db.shops,
  db.products,
  db.customers,
  db.sales,
  db.ledger,
  db.outbox,
  db.saleDrafts,
  db.corrections,
  db.stockMoves,
  db.cashEntries,
  db.suppliers,
  db.purchases,
  db.supplierLedger,
  db.orders,
  db.baskets,
  db.customerOrders,
  db.orderEvents,
];
