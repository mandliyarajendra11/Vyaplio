import { loadBackupState } from "./backupReminder";
import { loadClosings } from "./cash";
import { db } from "./db";
import type { Shop } from "./db";
import { getMeta, setMeta } from "./meta";

export const FIRST_WEEK_STEPS = ["products", "practice", "stock", "backup", "close"] as const;
export type FirstWeekStep = (typeof FIRST_WEEK_STEPS)[number];
export interface FirstWeekState {
  skipped: FirstWeekStep[];
  practiceAt?: number;
  stockCheckedAt?: number;
}
const key = (shopId: string) => `firstWeek:${shopId}`;
const validStep = (value: unknown): value is FirstWeekStep => FIRST_WEEK_STEPS.includes(value as FirstWeekStep);

export async function getFirstWeekState(shopId: string): Promise<FirstWeekState> {
  const raw = await getMeta<Partial<FirstWeekState>>(key(shopId));
  return {
    skipped: Array.isArray(raw?.skipped) ? raw.skipped.filter(validStep) : [],
    practiceAt: typeof raw?.practiceAt === "number" && Number.isFinite(raw.practiceAt) ? raw.practiceAt : undefined,
    stockCheckedAt: typeof raw?.stockCheckedAt === "number" && Number.isFinite(raw.stockCheckedAt) ? raw.stockCheckedAt : undefined,
  };
}

export async function skipFirstWeekStep(shopId: string, step: FirstWeekStep, skip: boolean) {
  const current = await getFirstWeekState(shopId);
  const skipped = new Set(current.skipped);
  if (skip) skipped.add(step);
  else skipped.delete(step);
  await setMeta(key(shopId), { ...current, skipped: [...skipped] });
}

export async function markFirstWeekStep(shopId: string, step: "practice" | "stock") {
  const current = await getFirstWeekState(shopId);
  const at = Date.now();
  await setMeta(key(shopId), {
    ...current,
    skipped: current.skipped.filter((s) => s !== step),
    ...(step === "practice" ? { practiceAt: at } : { stockCheckedAt: at }),
  });
}

export interface FirstWeekProgress {
  state: FirstWeekState;
  done: Record<FirstWeekStep, boolean>;
}

/** Real app records decide completion; an owner can skip but cannot fake a backup or cash close. */
export async function loadFirstWeekProgress(shop: Shop): Promise<FirstWeekProgress> {
  const [state, products, backup, closings] = await Promise.all([
    getFirstWeekState(shop.id),
    db.products.where("shopId").equals(shop.id).toArray(),
    loadBackupState(shop),
    loadClosings(shop.id, 1),
  ]);
  return {
    state,
    done: {
      products: products.some((p) => (p.nameHi || p.nameEn) && p.sellPrice > 0),
      practice: !!state.practiceAt,
      stock: !!state.stockCheckedAt,
      backup: backup.lastAt !== null,
      close: closings.length > 0,
    },
  };
}
