import type { Product, Sale, Shop } from "./db";
import { pendingUpi } from "./payments";
import { DAY_MS, daysSince, daysUntil } from "./dates";

export interface ExpiringProduct extends Product {
  days: number; // negative = already expired
}
export interface DeadProduct extends Product {
  idle: number; // days since last sale
}
export interface Alerts {
  /** Stock below zero: more was sold than recorded. Needs a count / reasoned correction. */
  shortage: Product[];
  /** At or under the reorder level (0 included, below-zero items are under `shortage`). */
  low: Product[];
  expiring: ExpiringProduct[];
  dead: DeadProduct[];
  /** Bills whose UPI part is not confirmed yet ("पैसे आ गए" not pressed). Oldest first. */
  pendingUpi: (Sale & { pending: number })[];
  total: number;
}

export function computeAlerts(products: Product[], shop: Shop, now: number, sales: Sale[] = []): Alerts {
  const upi = sales
    .map((s) => ({ ...s, pending: pendingUpi(s) }))
    .filter((s) => s.pending > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  const shortage = products.filter((p) => p.qty < 0).sort((a, b) => a.qty - b.qty);
  const low = products
    .filter((p) => p.qty >= 0 && p.qty <= p.lowStockAt)
    .sort((a, b) => a.qty / Math.max(a.lowStockAt, 1) - b.qty / Math.max(b.lowStockAt, 1));

  const expiring = products
    .filter((p) => p.expiryDate && p.qty > 0)
    .map((p) => ({ ...p, days: daysUntil(p.expiryDate as string, now) }))
    .filter((p) => p.days <= shop.expiryWarnDays)
    .sort((a, b) => a.days - b.days);

  const cutoff = now - shop.deadStockDays * DAY_MS;
  const dead = products
    .filter((p) => p.qty > 0 && (p.lastSoldAt ?? p.createdAt) < cutoff)
    .map((p) => ({ ...p, idle: daysSince(p.lastSoldAt ?? p.createdAt, now) }))
    .sort((a, b) => b.idle - a.idle);

  return {
    shortage,
    low,
    expiring,
    dead,
    pendingUpi: upi,
    total: upi.length + shortage.length + low.length + expiring.length + dead.length,
  };
}
