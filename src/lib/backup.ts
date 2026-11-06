import {
  CASH_KINDS,
  db,
  DENOMS,
  EXPENSE_CATEGORIES,
  STOCK_MOVE_REASONS,
  type CashEntry,
  UNITS,
  type Customer,
  type LedgerEntry,
  type Product,
  type Sale,
  type SaleCorrection,
  type Shop,
  type StockMove,
  type Purchase,
  type PurchaseOrder,
  type Supplier,
  type SupplierEntry,
  SUPPLIER_ENTRY_TYPES,
  shopTables,
  ORDER_SOURCES,
  ORDER_STATUSES,
  type Basket,
  type CustomerOrder,
  type OrderEvent,
  type Unit,
} from "./db";
import { dayKey } from "./dates";
import { round2 } from "./money";
import { grossLineTotal, lineTotal, kindForUnit, PRODUCT_KINDS, unitsFor, validStep } from "./units";
import { roundOffAmount, roundOffTotal } from "./discounts";
import { enqueue } from "./ops";
import { PAY_METHODS, paymentsOf } from "./payments";
import { getCloudLink, setCloudLink } from "./sync";
import { ensureSupplierRecords } from "./suppliers";
import type { SyncTable } from "./db";

/*
 * Offline backup file: the whole shop as JSON (optionally encrypted with a password).
 * Restore validates everything first, shows a preview, and then REPLACES the shop on this
 * phone in one transaction. It never merges, so a bad file can never mix into good data.
 */

// Keep the original format identifier so existing backups remain importable after rebranding.
export const BACKUP_FORMAT = "dukaanmitra-backup";
/**
 * v2: bills carry split payments (sales[].payments, corrections[].refunds).
 * v3: cash drawer entries (cashEntries) and ledger payment method.
 * v4: supplier diary (suppliers, purchases, supplierLedger, orders). v1–v3 files are still read
 *     (no supplier rows: records are created from the free-text supplier names after restore).
 * v5: repeat orders (baskets, customerOrders, orderEvents; customers' address / landmark; sales.orderId).
 *     Older files restore with none.
 * v6: sealed packs vs loose goods (products' kind / step / mrp / looseId / packSize; "openPack" stock
 *     moves; bill, return, basket and order lines' "₹20" amount; purchase lines' batch expiry).
 *     Older files restore with each product's kind taken from its unit (kg / ltr = loose).
 * v7: allocated bill discounts on sale lines. Older apps must not restore and misvalue their returns.
 * v8: optional line round-off. Older apps must not restore and misvalue rounded returns.
 */
export const BACKUP_VERSION = 8;

export interface BackupData {
  shop: Shop;
  products: Product[];
  customers: Customer[];
  sales: Sale[];
  ledger: LedgerEntry[];
  corrections: SaleCorrection[];
  stockMoves: StockMove[];
  /** v3+; missing in older files (= no drawer entries). */
  cashEntries: CashEntry[];
  /** v4+; missing in older files. */
  suppliers: Supplier[];
  purchases: Purchase[];
  supplierLedger: SupplierEntry[];
  orders: PurchaseOrder[];
  /** v5+; missing in older files. */
  baskets: Basket[];
  customerOrders: CustomerOrder[];
  orderEvents: OrderEvent[];
}
interface PlainFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  encrypted?: false;
  exportedAt: number;
  shopId: string;
  shopName: string;
  checksum: string;
  data: BackupData;
}
interface EncryptedFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  encrypted: true;
  exportedAt: number;
  shopName: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  payload: string;
}

export type BackupErrorCode = "notJson" | "notBackup" | "newerVersion" | "needPassword" | "wrongPassword" | "checksum" | "invalid" | "otherAccount" | "noCrypto";
export class BackupError extends Error {
  constructor(
    public code: BackupErrorCode,
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface BackupPreview {
  shopName: string;
  ownerName: string;
  exportedAt: number;
  products: number;
  customers: number;
  bills: number;
  cancelledBills: number;
  udhaarTotal: number;
  ledger: number;
  corrections: number;
  /** Supplier diary (0 in files older than v4). */
  suppliers: number;
  purchases: number;
  supplierOwed: number;
  /** Repeat orders (0 in files older than v5). */
  baskets: number;
  customerOrders: number;
  encrypted: boolean;
  /** Non-fatal oddities the owner should know before restoring. */
  warnings: { code: "balanceMismatch" | "stockMismatch"; count: number }[];
}

/* ------------------------------ helpers ------------------------------ */

const subtle = () => globalThis.crypto?.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Plain-JS SHA-256 for insecure (http LAN) pages, where SubtleCrypto does not exist. */
function sha256js(bytes: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

async function checksum(text: string) {
  const c = subtle();
  const bytes = enc.encode(text);
  const digest = c ? new Uint8Array(await c.digest("SHA-256", bytes)) : sha256js(bytes);
  return "sha256:" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function keyFrom(password: string, salt: Uint8Array, iterations: number) {
  const c = subtle();
  if (!c) throw new BackupError("noCrypto");
  const base = await c.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return c.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const byId = <T extends { id: string }>(rows: T[]) => rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/* ------------------------------ export ------------------------------ */

export async function collectShop(shopId: string): Promise<BackupData> {
  const shop = await db.shops.get(shopId);
  if (!shop) throw new BackupError("invalid", "shop");
  const where = <T>(t: { where(k: string): { equals(v: string): { toArray(): Promise<T[]> } } }) => t.where("shopId").equals(shopId).toArray();
  return {
    shop,
    products: byId(await where<Product>(db.products)),
    customers: byId(await where<Customer>(db.customers)),
    sales: byId(await where<Sale>(db.sales)),
    ledger: byId(await where<LedgerEntry>(db.ledger)),
    corrections: byId(await where<SaleCorrection>(db.corrections)),
    stockMoves: byId(await where<StockMove>(db.stockMoves)),
    cashEntries: byId(await where<CashEntry>(db.cashEntries)),
    suppliers: byId(await where<Supplier>(db.suppliers)),
    purchases: byId(await where<Purchase>(db.purchases)),
    supplierLedger: byId(await where<SupplierEntry>(db.supplierLedger)),
    orders: byId(await where<PurchaseOrder>(db.orders)),
    baskets: byId(await where<Basket>(db.baskets)),
    customerOrders: byId(await where<CustomerOrder>(db.customerOrders)),
    orderEvents: byId(await where<OrderEvent>(db.orderEvents)),
  };
}

export async function createBackup(shopId: string, password?: string): Promise<{ text: string; filename: string }> {
  const data = await collectShop(shopId);
  const body = JSON.stringify(data);
  const now = Date.now();
  const plain: PlainFile = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now, shopId, shopName: data.shop.name, checksum: await checksum(body), data };
  let text = JSON.stringify(plain);
  if (password) {
    const c = subtle();
    if (!c) throw new BackupError("noCrypto");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const iterations = 250_000;
    const key = await keyFrom(password, salt, iterations);
    const ct = new Uint8Array(await c.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text)));
    const file: EncryptedFile = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      encrypted: true,
      exportedAt: now,
      shopName: data.shop.name,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) },
      cipher: { name: "AES-GCM", iv: b64(iv) },
      payload: b64(ct),
    };
    text = JSON.stringify(file);
  }
  return { text, filename: `vyaplio-backup-${dayKey(now)}-${shopId.slice(0, 8)}${password ? "-locked" : ""}.json` };
}

/** Share sheet (WhatsApp, Files, Drive…) where supported, otherwise a normal download. */
export async function shareOrDownload(text: string, filename: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([text], filename, { type: "application/json" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      /* fall through to download */
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

/* ------------------------------ read + validate ------------------------------ */

/** Parse a backup file. Throws BackupError; `needPassword` means: ask and call again. */
export async function readBackup(text: string, password?: string): Promise<{ data: BackupData; preview: BackupPreview }> {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BackupError("notJson");
  }
  const f = obj as Partial<Omit<PlainFile, "encrypted"> & Omit<EncryptedFile, "encrypted">> & { encrypted?: boolean };
  if (!f || typeof f !== "object" || f.format !== BACKUP_FORMAT) throw new BackupError("notBackup");
  if (typeof f.version !== "number" || f.version > BACKUP_VERSION) throw new BackupError("newerVersion");
  let encrypted = false;
  let plain = f as unknown as Partial<PlainFile>;
  if (f.encrypted) {
    encrypted = true;
    if (!password) throw new BackupError("needPassword");
    const e = f as unknown as EncryptedFile;
    let bytes: ArrayBuffer;
    try {
      const key = await keyFrom(password, unb64(e.kdf.salt), e.kdf.iterations);
      bytes = await subtle()!.decrypt({ name: "AES-GCM", iv: unb64(e.cipher.iv) as BufferSource }, key, unb64(e.payload) as BufferSource);
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError("wrongPassword");
    }
    try {
      plain = JSON.parse(dec.decode(bytes));
    } catch {
      throw new BackupError("notJson");
    }
    if (plain.format !== BACKUP_FORMAT) throw new BackupError("notBackup");
  }
  if (!plain.data || typeof plain.checksum !== "string") throw new BackupError("invalid", "data");
  if ((await checksum(JSON.stringify(plain.data))) !== plain.checksum) throw new BackupError("checksum");
  const data = validate(plain.data);
  return { data, preview: previewOf(data, plain.exportedAt ?? 0, encrypted) };
}

const isStr = (v: unknown) => typeof v === "string" && v.length > 0;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
const optNum = (v: unknown) => v === undefined || v === null || isNum(v);
const optBool = (v: unknown) => v === undefined || v === null || typeof v === "boolean";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(d: BackupData): BackupData {
  const fail = (where: string) => {
    throw new BackupError("invalid", where);
  };
  const s = d.shop;
  if (!s || !isStr(s.id) || !isStr(s.name) || !isNum(s.createdAt)) fail("shop");
  if (!["hi", "en"].includes(s.language)) fail("shop.language");
  if (!isNum(s.deadStockDays) || !isNum(s.expiryWarnDays)) fail("shop.settings");
  d.cashEntries ??= []; // v1 / v2 files have no drawer entries
  d.suppliers ??= []; // v1–v3 files have no supplier diary
  d.purchases ??= [];
  d.supplierLedger ??= [];
  d.orders ??= [];
  d.baskets ??= []; // v1–v4 files have no repeat orders
  d.customerOrders ??= [];
  d.orderEvents ??= [];
  const tables = ["products", "customers", "sales", "ledger", "corrections", "stockMoves", "cashEntries", "suppliers", "purchases", "supplierLedger", "orders", "baskets", "customerOrders", "orderEvents"] as const;
  for (const t of tables) if (!Array.isArray(d[t])) fail(t);
  const ids: Record<string, Set<string>> = {};
  for (const t of tables) {
    ids[t] = new Set();
    (d[t] as { id: unknown; shopId: unknown; createdAt: unknown }[]).forEach((r, i) => {
      const at = `${t}[${i}]`;
      if (!r || typeof r !== "object" || !isStr(r.id)) fail(at + ".id");
      if (ids[t].has(r.id as string)) fail(at + ".id (duplicate)");
      ids[t].add(r.id as string);
      if (r.shopId !== s.id) fail(at + ".shopId");
      if (!isNum(r.createdAt)) fail(at + ".createdAt");
    });
  }
  d.products.forEach((p, i) => {
    const at = `products[${i}]`;
    if (!isStr(p.nameHi) || !optStr(p.nameEn)) fail(at + ".name");
    if (!UNITS.includes(p.unit)) fail(at + ".unit");
    for (const k of ["qty", "buyPrice", "sellPrice", "lowStockAt"] as const) if (!isNum(p[k])) fail(`${at}.${k}`);
    if (!optNum(p.salesCount) || !optNum(p.lastSoldAt) || !optStr(p.expiryDate) || !optNum(p.buyPriceAt)) fail(at);
    if (p.aliases != null && (!Array.isArray(p.aliases) || !p.aliases.every((a) => typeof a === "string"))) fail(at + ".aliases");
    // Packs vs loose (v6). Older files: the kind follows the unit.
    if (p.kind == null) p.kind = kindForUnit(p.unit);
    if (!(PRODUCT_KINDS as readonly string[]).includes(p.kind) || !unitsFor(p.kind).includes(p.unit)) fail(at + ".kind");
    if (!optNum(p.step) || (p.step != null && !validStep(p.step))) fail(at + ".step");
    if (!optNum(p.mrp) || (p.mrp ?? 0) < 0) fail(at + ".mrp");
    if (!optStr(p.looseId) || !optNum(p.packSize) || (p.looseId && !((p.packSize ?? 0) > 0))) fail(at + ".pack");
  });
  d.products.forEach((p, i) => {
    if (p.looseId && !ids.products.has(p.looseId)) fail(`products[${i}].looseId`);
  });
  d.customers.forEach((c, i) => {
    if (typeof c.name !== "string" || !isNum(c.balance) || !optStr(c.phone) || !optStr(c.address) || !optStr(c.landmark)) fail(`customers[${i}]`);
  });
  d.sales.forEach((x, i) => {
    const at = `sales[${i}]`;
    if (!Array.isArray(x.items) || x.items.length === 0) fail(at + ".items");
    x.items.forEach((it, j) => {
      if (!it || !isStr(it.productId) || !isNum(it.qty) || it.qty <= 0 || !isNum(it.price) || !isNum(it.cost)) fail(`${at}.items[${j}]`);
      if (!optNum(it.returnedQty) || (it.returnedQty ?? 0) < 0 || (it.returnedQty ?? 0) > it.qty + 1e-9) fail(`${at}.items[${j}].returnedQty`);
      // Cost snapshot (honest profit): optional on older files, where cost 0 is read as unknown.
      if (!optBool(it.costKnown) || !optNum(it.costAt) || !optBool(it.costFilled) || it.cost < 0) fail(`${at}.items[${j}].cost`);
      if (!optNum(it.amount) || (it.amount != null && it.amount <= 0)) fail(`${at}.items[${j}].amount`);
      if (!optNum(it.discount) || (it.discount != null && (it.discount < 0 || it.discount > grossLineTotal(it)
        || Math.abs(it.discount * 100 - Math.round(it.discount * 100)) > 1e-6))) fail(`${at}.items[${j}].discount`);
      if (!optNum(it.itemDiscount) || (it.itemDiscount != null && (it.itemDiscount < 0 || it.itemDiscount > (it.discount ?? 0)
        || Math.abs(it.itemDiscount * 100 - Math.round(it.itemDiscount * 100)) > 1e-6))) fail(`${at}.items[${j}].itemDiscount`);
      if (!optNum(it.rounding) || (it.rounding != null && (Math.abs(it.rounding) > 0.5
        || Math.abs(it.rounding * 100 - Math.round(it.rounding * 100)) > 1e-6
        || lineTotal(it) < 0))) fail(`${at}.items[${j}].rounding`);
    });
    if (!isNum(x.total) || !isNum(x.cost) || !["cash", "upi", "credit", "split"].includes(x.payment) || !DAY_RE.test(String(x.day))) fail(at);
    if (x.items.some((it) => it.discount !== undefined || it.rounding !== undefined) && Math.abs(round2(x.items.reduce((a, it) => a + lineTotal(it), 0)) - x.total) > 0.005) fail(at + ".discount/rounding (sum)");
    if (x.items.some((it) => it.rounding !== undefined) && Math.abs(roundOffAmount(round2(x.total - roundOffTotal(x.items))) - roundOffTotal(x.items)) > 0.005) fail(at + ".rounding (sum)");
    if (x.payments !== undefined && x.payments !== null) {
      if (!Array.isArray(x.payments) || !x.payments.length) fail(at + ".payments");
      x.payments.forEach((p, j) => {
        if (!p || !PAY_METHODS.includes(p.method) || !isNum(p.amount) || p.amount < 0) fail(`${at}.payments[${j}]`);
        if (p.status !== undefined && !["paid", "pending"].includes(p.status)) fail(`${at}.payments[${j}].status`);
        if (!optNum(p.tendered) || !optNum(p.change) || !optStr(p.ref) || !optNum(p.confirmedAt)) fail(`${at}.payments[${j}]`);
      });
    } else if (x.payment === "split") fail(at + ".payments");
    // A v1 (single-method) bill is read as one fully paid part; the row itself is kept as it was.
    const parts = paymentsOf(x);
    // Parts add up to the total, less any unconfirmed UPI reduced by later returns (≤ returned value).
    const paid = parts.reduce((a, p) => a + p.amount, 0);
    if (paid > x.total + 0.011 || paid < x.total - (x.returnedTotal ?? 0) - 0.011) fail(at + ".payments (sum)");
    if (parts.some((p) => p.method === "credit" && p.amount > 0) && !ids.customers.has(String(x.customerId))) fail(at + ".customerId");
    if (x.status !== undefined && !["active", "partially_returned", "cancelled"].includes(x.status)) fail(at + ".status");
    if (!optNum(x.returnedTotal) || !optNum(x.returnedCost)) fail(at + ".returned");
    if (!optStr(x.orderId)) fail(at + ".orderId");
  });
  d.ledger.forEach((e, i) => {
    const at = `ledger[${i}]`;
    if (!ids.customers.has(e.customerId)) fail(at + ".customerId");
    if (!["debit", "credit"].includes(e.type) || !isNum(e.amount) || e.amount <= 0) fail(at);
    if (e.saleId && !ids.sales.has(e.saleId)) fail(at + ".saleId");
    if (e.method !== undefined && e.method !== null && !["cash", "upi"].includes(e.method)) fail(at + ".method");
  });
  d.corrections.forEach((c, i) => {
    const at = `corrections[${i}]`;
    if (!ids.sales.has(c.saleId)) fail(at + ".saleId");
    if (!["return", "cancel"].includes(c.type) || !isStr(c.reason) || !Array.isArray(c.lines) || !isNum(c.amount) || c.amount < 0) fail(at);
    if (!["cash", "upi", "credit"].includes(c.refundMethod) || !DAY_RE.test(String(c.day))) fail(at);
    if (c.lines.some((l) => !l || !optNum(l.amount) || (l.amount ?? 0) < 0)) fail(at + ".lines");
    if (c.refunds !== undefined && c.refunds !== null) {
      if (!Array.isArray(c.refunds)) fail(at + ".refunds");
      c.refunds.forEach((r, j) => {
        if (!r || ![...PAY_METHODS, "upiPending"].includes(r.method) || !isNum(r.amount) || r.amount < 0) fail(`${at}.refunds[${j}]`);
      });
      if (Math.abs(c.refunds.reduce((a, r) => a + r.amount, 0) - c.amount) > 0.011) fail(at + ".refunds (sum)");
    }
  });
  d.cashEntries.forEach((e, i) => {
    const at = `cashEntries[${i}]`;
    if (!(CASH_KINDS as readonly string[]).includes(e.kind) || !DAY_RE.test(String(e.day)) || !isNum(e.amount) || e.amount < 0) fail(at);
    if (e.category !== undefined && e.category !== null && !(EXPENSE_CATEGORIES as readonly string[]).includes(e.category)) fail(at + ".category");
    if (e.kind === "void" && !ids.cashEntries.has(String(e.voidsId))) fail(at + ".voidsId");
    if (!optStr(e.note) || !optStr(e.reason) || !optStr(e.supplierName) || !optNum(e.expected) || !optNum(e.diff)) fail(at);
    if (e.denoms !== undefined && e.denoms !== null) {
      if (typeof e.denoms !== "object") fail(at + ".denoms");
      for (const [k, n] of Object.entries(e.denoms)) if ((k !== "coins" && !(DENOMS as readonly number[]).includes(Number(k))) || !isNum(n) || n < 0) fail(at + ".denoms");
    }
  });
  d.suppliers.forEach((x, i) => {
    const at = `suppliers[${i}]`;
    if (!isStr(x.name) || !optStr(x.phone) || !optStr(x.items) || !optStr(x.notes) || !optNum(x.termsDays) || !isNum(x.updatedAt)) fail(at);
    if (x.termsDays != null && (x.termsDays < 0 || x.termsDays > 365)) fail(at + ".termsDays");
  });
  d.purchases.forEach((x, i) => {
    const at = `purchases[${i}]`;
    if (!ids.suppliers.has(x.supplierId)) fail(at + ".supplierId");
    if (!DAY_RE.test(String(x.day)) || (x.dueDate != null && !DAY_RE.test(String(x.dueDate)))) fail(at + ".day");
    if (!Array.isArray(x.lines) || !x.lines.length) fail(at + ".lines");
    x.lines.forEach((l, j) => {
      if (!l || !isStr(l.productId) || !isNum(l.qty) || l.qty <= 0 || !isNum(l.buyPrice) || l.buyPrice < 0 || !UNITS.includes(l.unit) || !optNum(l.prevBuyPrice)) fail(`${at}.lines[${j}]`);
      if (l.expiryDate != null && !DAY_RE.test(String(l.expiryDate))) fail(`${at}.lines[${j}].expiryDate`);
    });
    for (const k of ["total", "paidCash", "paidUpi", "credit"] as const) if (!isNum(x[k]) || x[k] < -0.011) fail(`${at}.${k}`);
    if (Math.abs(x.paidCash + x.paidUpi + x.credit - x.total) > 0.011) fail(at + ".paid (sum)");
    if (!optStr(x.billNo) || !optStr(x.note) || !optStr(x.orderId)) fail(at);
  });
  d.supplierLedger.forEach((e, i) => {
    const at = `supplierLedger[${i}]`;
    if (!ids.suppliers.has(e.supplierId)) fail(at + ".supplierId");
    if (!(SUPPLIER_ENTRY_TYPES as readonly string[]).includes(e.type) || !isNum(e.amount) || !DAY_RE.test(String(e.day))) fail(at);
    if (e.type === "adjust" ? e.amount === 0 : e.amount <= 0) fail(at + ".amount");
    if ((e.type === "return" || e.type === "adjust") && !isStr(e.reason)) fail(at + ".reason");
    if (e.method != null && !["cash", "upi"].includes(e.method)) fail(at + ".method");
    if (e.purchaseId && !ids.purchases.has(e.purchaseId)) fail(at + ".purchaseId");
    if (e.dueDate != null && !DAY_RE.test(String(e.dueDate))) fail(at + ".dueDate");
  });
  d.orders.forEach((o, i) => {
    const at = `orders[${i}]`;
    if (!ids.suppliers.has(o.supplierId) || !["ordered", "received", "cancelled"].includes(o.status) || !Array.isArray(o.lines) || !isNum(o.updatedAt)) fail(at);
    o.lines.forEach((l, j) => {
      if (!l || !isStr(l.productId) || !isNum(l.qty) || l.qty <= 0 || !UNITS.includes(l.unit)) fail(`${at}.lines[${j}]`);
    });
  });
  const lineOk = (l: { productId: unknown; qty: unknown; unit: unknown; amount?: unknown }) =>
    !!l && isStr(l.productId) && isNum(l.qty) && (l.qty as number) > 0 && UNITS.includes(l.unit as Unit) && optNum(l.amount) && (l.amount == null || (l.amount as number) > 0);
  d.baskets.forEach((b, i) => {
    const at = `baskets[${i}]`;
    if (!ids.customers.has(b.customerId) || !isStr(b.name) || !Array.isArray(b.lines) || !isNum(b.updatedAt) || !optNum(b.deletedAt) || !optStr(b.fromSaleId)) fail(at);
    b.lines.forEach((l, j) => {
      if (!lineOk(l) || !optNum(l.price)) fail(`${at}.lines[${j}]`);
    });
  });
  d.customerOrders.forEach((o, i) => {
    const at = `customerOrders[${i}]`;
    if (!ids.customers.has(o.customerId) || !Array.isArray(o.lines) || !o.lines.length || !isNum(o.updatedAt)) fail(at);
    if (!["packed", "delivery"].includes(o.billAt) || !(ORDER_SOURCES as readonly string[]).includes(o.source)) fail(at + ".billAt");
    if (!optStr(o.text) || !optStr(o.note) || (o.unmatched != null && (!Array.isArray(o.unmatched) || !o.unmatched.every((u) => typeof u === "string")))) fail(at);
    o.lines.forEach((l, j) => {
      if (!lineOk(l) || !isNum(l.price) || !optNum(l.packedQty) || (l.packedQty ?? 0) < 0 || !optBool(l.packed)) fail(`${at}.lines[${j}]`);
    });
  });
  d.orderEvents.forEach((e, i) => {
    const at = `orderEvents[${i}]`;
    if (!ids.customerOrders.has(e.orderId)) fail(at + ".orderId");
    if (!["status", "bill"].includes(e.type)) fail(at + ".type");
    if (e.type === "status" && !(ORDER_STATUSES as readonly string[]).includes(String(e.status))) fail(at + ".status");
    if (e.type === "bill" && !ids.sales.has(String(e.saleId))) fail(at + ".saleId");
  });
  d.stockMoves.forEach((m, i) => {
    if (!isStr(m.productId) || !isNum(m.delta) || !(STOCK_MOVE_REASONS as readonly string[]).includes(m.reason)) fail(`stockMoves[${i}]`);
    if (!optNum(m.shortBy) || !optNum(m.counted) || !optStr(m.note) || !optNum(m.unitCost)) fail(`stockMoves[${i}]`);
  });
  return d;
}

function previewOf(d: BackupData, exportedAt: number, encrypted: boolean): BackupPreview {
  const bal = new Map<string, number>();
  for (const e of d.ledger) bal.set(e.customerId, (bal.get(e.customerId) ?? 0) + (e.type === "debit" ? e.amount : -e.amount));
  const balanceMismatch = d.customers.filter((c) => round2(bal.get(c.id) ?? 0) !== round2(c.balance)).length;
  const qty = new Map<string, number>();
  for (const m of d.stockMoves) qty.set(m.productId, (qty.get(m.productId) ?? 0) + m.delta);
  const stockMismatch = d.products.filter((p) => qty.has(p.id) && round2(qty.get(p.id)!) !== round2(p.qty)).length;
  const warnings: BackupPreview["warnings"] = [];
  if (balanceMismatch) warnings.push({ code: "balanceMismatch", count: balanceMismatch });
  if (stockMismatch) warnings.push({ code: "stockMismatch", count: stockMismatch });
  return {
    shopName: d.shop.name,
    ownerName: d.shop.ownerName,
    exportedAt,
    products: d.products.length,
    customers: d.customers.length,
    bills: d.sales.length,
    cancelledBills: d.sales.filter((x) => x.status === "cancelled").length,
    udhaarTotal: round2(d.customers.reduce((a, c) => a + Math.max(0, c.balance), 0)),
    ledger: d.ledger.length,
    corrections: d.corrections.length,
    suppliers: d.suppliers.length,
    purchases: d.purchases.length,
    supplierOwed: round2(d.supplierLedger.reduce((a, e) => a + (e.type === "purchase" || e.type === "adjust" ? e.amount : -e.amount), 0)),
    baskets: d.baskets.filter((b) => !b.deletedAt).length,
    customerOrders: d.customerOrders.length,
    encrypted,
    warnings,
  };
}

/* ------------------------------ restore ------------------------------ */

const DATA_TABLES = () => [...shopTables(), db.meta];

/** Remove one shop's data from this phone (inside the caller's transaction). */
export async function wipeShopData(shopId: string) {
  await db.shops.delete(shopId);
  await db.saleDrafts.delete(shopId);
  await db.meta.delete(`pullCursor:${shopId}`);
  for (const t of [db.products, db.customers, db.sales, db.ledger, db.corrections, db.stockMoves, db.cashEntries, db.suppliers, db.purchases, db.supplierLedger, db.orders, db.baskets, db.customerOrders, db.orderEvents, db.outbox] as const)
    await (t as typeof db.products).where("shopId").equals(shopId).delete();
}

const SNAPSHOT: [SyncTable, keyof Omit<BackupData, "shop">][] = [
  ["products", "products"],
  ["customers", "customers"],
  ["sales", "sales"],
  ["credit_ledger", "ledger"],
  ["sale_corrections", "corrections"],
  ["stock_moves", "stockMoves"],
  ["cash_entries", "cashEntries"],
  ["suppliers", "suppliers"],
  ["purchases", "purchases"],
  ["supplier_ledger", "supplierLedger"],
  ["purchase_orders", "orders"],
  ["baskets", "baskets"],
  ["customer_orders", "customerOrders"],
  ["order_events", "orderEvents"],
];

/** Queue every row of the shop for upload (used when linking a shop to the cloud). */
export async function enqueueSnapshot(shopId: string) {
  await db.transaction("rw", DATA_TABLES(), async () => {
    await db.outbox.where("shopId").equals(shopId).delete();
    const d = await collectShop(shopId);
    await enqueue("shops", "upsert", d.shop.id, d.shop);
    // Suppliers before their bills (foreign keys): the outbox pushes in SYNC_ORDER anyway.
    for (const [table, key] of SNAPSHOT) for (const row of d[key]) await enqueue(table, "upsert", row.id, row);
  });
}

/**
 * Replace this phone's shop with the backup, exactly as it was saved. `replaceShopId` is the
 * shop the current account had before (it is removed too, so the account ends with one shop).
 */
export async function restoreBackup(data: BackupData, ownerId: string, replaceShopId?: string) {
  const link = await getCloudLink();
  const existing = await db.shops.get(data.shop.id);
  if (existing && existing.ownerId !== ownerId && existing.id !== replaceShopId) throw new BackupError("otherAccount");
  await db.transaction("rw", DATA_TABLES(), async () => {
    if (replaceShopId && replaceShopId !== data.shop.id) await wipeShopData(replaceShopId);
    await wipeShopData(data.shop.id);
    await db.shops.add({ ...data.shop, ownerId });
    await db.products.bulkAdd(data.products);
    await db.customers.bulkAdd(data.customers);
    await db.sales.bulkAdd(data.sales);
    await db.ledger.bulkAdd(data.ledger);
    await db.corrections.bulkAdd(data.corrections);
    await db.stockMoves.bulkAdd(data.stockMoves);
    await db.cashEntries.bulkAdd(data.cashEntries ?? []);
    await db.suppliers.bulkAdd(data.suppliers ?? []);
    await db.purchases.bulkAdd(data.purchases ?? []);
    await db.supplierLedger.bulkAdd(data.supplierLedger ?? []);
    await db.orders.bulkAdd(data.orders ?? []);
    await db.baskets.bulkAdd(data.baskets ?? []);
    await db.customerOrders.bulkAdd(data.customerOrders ?? []);
    await db.orderEvents.bulkAdd(data.orderEvents ?? []);
  });
  // Older files: supplier records from the free-text names (same ids as the v8 migration).
  await ensureSupplierRecords(data.shop.id);
  // Cloud: the same shop stays linked and the restored rows are queued (server keeps newer rows);
  // a different shop cannot reuse the old link.
  if (link && link.localUserId === ownerId) {
    if (link.shopId === data.shop.id) await enqueueSnapshot(data.shop.id);
    else await setCloudLink(null);
  }
}
