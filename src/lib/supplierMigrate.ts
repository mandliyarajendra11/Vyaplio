import type { CashEntry, Product, Supplier } from "./db";

/*
 * Supplier records from the old free-text fields (product.supplier, galla supplier payments).
 * Pure (no database): used by the v8 upgrade, after a cloud pull and after restoring an old backup.
 * Nothing is removed: the free text stays on products / galla entries; products only gain a link.
 */

/** Same supplier for "Sharma Traders", " sharma  traders ". */
export const normName = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** 64-bit FNV-1a (two 32-bit halves) as hex: stable across phones and browsers. */
function fnv(text: string) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Id of a supplier created from a name: the same on every phone (so migrations never duplicate). */
export const supplierIdFor = (shopId: string, name: string) => `sup-${fnv(shopId + "|" + normName(name))}`;

export interface SupplierPlan {
  created: Supplier[];
  /** [productId, supplierId] for products whose free-text supplier now has a record. */
  links: [string, string][];
}

export function planSuppliers(products: Product[], cash: CashEntry[], existing: Supplier[], now: number): SupplierPlan {
  const byKey = new Map<string, Supplier>(); // shopId|normName -> supplier
  const byId = new Map<string, Supplier>();
  for (const s of existing) {
    byKey.set(s.shopId + "|" + normName(s.name), s);
    byId.set(s.id, s);
  }
  const created = new Map<string, Supplier>();
  const items = new Map<string, string[]>();

  const ensure = (shopId: string, rawName: string, at: number, id?: string) => {
    const name = rawName.trim().replace(/\s+/g, " ").slice(0, 80);
    if (id && byId.has(id)) return byId.get(id)!;
    const key = shopId + "|" + normName(name);
    if (name && byKey.has(key)) return byKey.get(key)!;
    if (!name && !id) return undefined;
    const sid = id || supplierIdFor(shopId, name);
    // Stable timestamps (earliest source row) so two phones migrating alone write identical rows.
    const s: Supplier = { id: sid, shopId, name: name || sid, createdAt: at || now, updatedAt: at || now };
    created.set(sid, s);
    byId.set(sid, s);
    if (name) byKey.set(key, s);
    return s;
  };

  // Oldest first, so the first spelling seen becomes the record's name.
  const prods = products.filter((p) => p.supplier?.trim() && !p.deletedAt).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const links: [string, string][] = [];
  for (const p of prods) {
    const s = ensure(p.shopId, p.supplier!, p.createdAt, p.supplierId && byId.has(p.supplierId) ? p.supplierId : undefined)!;
    if (p.supplierId !== s.id) links.push([p.id, s.id]);
    if (created.has(s.id)) {
      const list = items.get(s.id) ?? [];
      const n = p.nameHi || p.nameEn;
      if (n && !list.includes(n)) list.push(n);
      items.set(s.id, list);
    }
  }
  const pays = cash.filter((e) => e.kind === "supplier" && (e.supplierName?.trim() || e.supplierId)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const e of pays) ensure(e.shopId, e.supplierName ?? "", e.createdAt, e.supplierId?.trim() || undefined);

  for (const [id, list] of items) {
    const s = created.get(id)!;
    if (list.length) s.items = list.join(", ").slice(0, 200);
  }
  return { created: [...created.values()], links };
}
