import type { SyncTable, Unit } from "./db";
import { kindForUnit } from "./units";

/**
 * Local (Dexie, camelCase, ms timestamps) <-> cloud (Postgres, snake_case, timestamptz) mapping.
 * Column lists are explicit so an unknown local field can never break an upsert, and every
 * column is always sent (null when empty) so a batch has one consistent shape.
 */
type Spec = {
  local: "shops" | "products" | "customers" | "sales" | "ledger" | "corrections" | "stockMoves" | "cashEntries" | "suppliers" | "purchases" | "supplierLedger" | "orders" | "baskets" | "customerOrders" | "orderEvents";
  cols: string[];
  ts?: string[];
  num?: string[];
  defaults?: Record<string, unknown>;
  /** Never updated once written: pushed with insert-on-conflict-do-nothing. */
  appendOnly?: boolean;
};

const TS = ["createdAt", "updatedAt", "lastSoldAt", "lastPaidAt", "deletedAt", "buyPriceAt"];

export const SPECS: Record<SyncTable, Spec> = {
  shops: {
    local: "shops",
    cols: ["id", "ownerId", "name", "ownerName", "phone", "upiId", "language", "deadStockDays", "expiryWarnDays", "isDemo", "createdAt", "updatedAt"],
    num: ["deadStockDays", "expiryWarnDays"],
    defaults: { language: "hi", deadStockDays: 30, expiryWarnDays: 7, isDemo: false },
  },
  products: {
    local: "products",
    cols: ["id", "shopId", "nameHi", "nameEn", "barcode", "unit", "qty", "buyPrice", "buyPriceAt", "sellPrice", "lowStockAt", "expiryDate", "supplier", "supplierId", "reorderTo", "aliases", "kind", "step", "mrp", "looseId", "packSize", "lastSoldAt", "salesCount", "createdAt", "updatedAt", "deletedAt"],
    num: ["qty", "buyPrice", "sellPrice", "lowStockAt", "reorderTo", "step", "mrp", "packSize", "salesCount"],
    defaults: { unit: "pcs", qty: 0, buyPrice: 0, sellPrice: 0, lowStockAt: 0, salesCount: 0 },
  },
  customers: {
    local: "customers",
    cols: ["id", "shopId", "name", "phone", "address", "landmark", "balance", "lastPaidAt", "createdAt", "updatedAt"],
    num: ["balance"],
    defaults: { balance: 0 },
  },
  sales: {
    local: "sales",
    cols: ["id", "shopId", "items", "total", "cost", "payment", "payments", "customerId", "day", "status", "returnedTotal", "returnedCost", "orderId", "createdAt", "updatedAt"],
    num: ["total", "cost", "returnedTotal", "returnedCost"],
    defaults: { items: [], cost: 0, status: "active", returnedTotal: 0, returnedCost: 0 },
  },
  credit_ledger: {
    local: "ledger",
    cols: ["id", "shopId", "customerId", "type", "amount", "note", "saleId", "kind", "method", "correctionId", "createdAt"],
    num: ["amount"],
    appendOnly: true,
  },
  sale_corrections: {
    local: "corrections",
    cols: ["id", "shopId", "saleId", "type", "reason", "lines", "amount", "cost", "refundMethod", "refunds", "crossMethod", "customerId", "byUserId", "byName", "createdAt", "day"],
    num: ["amount", "cost"],
    defaults: { cost: 0 },
    appendOnly: true,
  },
  stock_moves: {
    local: "stockMoves",
    cols: ["id", "shopId", "productId", "delta", "reason", "refId", "shortBy", "counted", "unitCost", "note", "createdAt"],
    num: ["delta", "shortBy", "counted", "unitCost"],
    appendOnly: true,
  },
  cash_entries: {
    local: "cashEntries",
    cols: ["id", "shopId", "day", "kind", "amount", "category", "note", "supplierId", "supplierName", "reason", "voidsId", "expected", "diff", "denoms", "afterClose", "byName", "createdAt"],
    num: ["amount", "expected", "diff"],
    appendOnly: true,
  },
  // Supplier diary (item 12). Suppliers / orders are edited (last write wins); bills and the
  // supplier ledger are append-only, so what we owe adds up across phones.
  suppliers: {
    local: "suppliers",
    cols: ["id", "shopId", "name", "phone", "items", "termsDays", "notes", "createdAt", "updatedAt"],
    num: ["termsDays"],
  },
  purchases: {
    local: "purchases",
    cols: ["id", "shopId", "supplierId", "day", "billNo", "lines", "total", "paidCash", "paidUpi", "credit", "dueDate", "orderId", "note", "byName", "createdAt"],
    num: ["total", "paidCash", "paidUpi", "credit"],
    defaults: { lines: [], paidCash: 0, paidUpi: 0, credit: 0 },
    appendOnly: true,
  },
  supplier_ledger: {
    local: "supplierLedger",
    cols: ["id", "shopId", "supplierId", "type", "amount", "day", "method", "purchaseId", "cashEntryId", "dueDate", "billNo", "reason", "note", "byName", "createdAt"],
    num: ["amount"],
    appendOnly: true,
  },
  purchase_orders: {
    local: "orders",
    cols: ["id", "shopId", "supplierId", "lines", "status", "purchaseId", "byName", "createdAt", "updatedAt"],
    defaults: { lines: [], status: "ordered" },
  },
  // WhatsApp repeat orders (item 13). Baskets and order rows (lines + packing ticks) are edited, last
  // write wins (a removed basket stays as a tombstone). The status history is append-only.
  baskets: {
    local: "baskets",
    cols: ["id", "shopId", "customerId", "name", "lines", "fromSaleId", "createdAt", "updatedAt", "deletedAt"],
    defaults: { lines: [] },
  },
  customer_orders: {
    local: "customerOrders",
    cols: ["id", "shopId", "customerId", "lines", "source", "basketId", "text", "unmatched", "billAt", "note", "byName", "createdAt", "updatedAt"],
    defaults: { lines: [], source: "manual", billAt: "delivery" },
  },
  order_events: {
    local: "orderEvents",
    cols: ["id", "shopId", "orderId", "type", "status", "saleId", "note", "byName", "createdAt"],
    appendOnly: true,
  },
};

/** Push order respects foreign keys (shop -> products/customers -> sales -> ledger/corrections). */
export const SYNC_ORDER: SyncTable[] = [
  "shops",
  "suppliers",
  "products",
  "customers",
  "sales",
  "credit_ledger",
  "sale_corrections",
  "stock_moves",
  "cash_entries",
  "purchases",
  "supplier_ledger",
  "purchase_orders",
  "baskets",
  "customer_orders",
  "order_events",
];

export const snake = (k: string) => k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());

export function toRemote(table: SyncTable, payload: unknown, uid: string): Record<string, unknown> {
  const spec = SPECS[table];
  const src = (payload ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of spec.cols) {
    let v = src[c];
    if (table === "shops" && c === "ownerId") v = uid; // RLS: a shop belongs to the signed-in cloud user
    if (v === undefined || v === null) v = spec.defaults?.[c] ?? null;
    if (v !== null && TS.includes(c) && typeof v === "number") v = new Date(v).toISOString();
    out[snake(c)] = v;
  }
  return out;
}

export function fromRemote(table: SyncTable, row: Record<string, unknown>, ownerId?: string): Record<string, unknown> {
  const spec = SPECS[table];
  const out: Record<string, unknown> = {};
  for (const c of spec.cols) {
    let v = row[snake(c)];
    if (v === null || v === undefined) continue;
    if (TS.includes(c)) v = typeof v === "number" ? v : Date.parse(String(v));
    else if (spec.num?.includes(c)) v = Number(v);
    else if (c === "expiryDate" || c === "day" || c === "dueDate") v = String(v).slice(0, 10);
    out[c] = v;
  }
  if (table === "shops" && ownerId) out.ownerId = ownerId;
  if (table === "shops" && out.isDemo === false) delete out.isDemo;
  // Rows written before packed / loose existed (or by an older app): the kind follows the unit.
  if (table === "products" && !out.kind) out.kind = kindForUnit((out.unit as Unit | undefined) ?? "pcs");
  return out;
}
