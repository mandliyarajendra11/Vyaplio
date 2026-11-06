"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useSyncExternalStore } from "react";
import { computeAlerts } from "./alerts";
import { loadCashDay, loadClosings } from "./cash";
import { DAY_MS, dayKey, startOfDayMs } from "./dates";
import { db, type Locale, type Sale, type Shop } from "./db";
import { canInstall, subscribeInstall } from "./install";
import { getOfflineServerStatus, getOfflineStatus, subscribeOffline } from "./offline";
import { orderCounts } from "./orders";
import { pendingUpi } from "./payments";
import * as prefs from "./prefs";
import { computeDayStats, type DayStats } from "./stats";
import { getCloudLink, getSyncStatus, isSyncRunning, pendingCount, subscribeSyncRunning } from "./sync";
import { loadSupplierDues } from "./suppliers";

const noopSubscribe = () => () => {};

/** false during SSR/prerender + hydration, true once running in the browser. */
export const useMounted = () =>
  useSyncExternalStore(noopSubscribe, () => true, () => false);

export const useLocalePref = () =>
  useSyncExternalStore(prefs.subscribe, prefs.getLocale, (): Locale => "hi");

export const useSessionUser = () =>
  useSyncExternalStore(prefs.subscribe, prefs.getSession, () => null);

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}
export const useOnline = () =>
  useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

/** Whether the service worker has the whole app stored for use without internet. */
export const useOfflineStatus = () => useSyncExternalStore(subscribeOffline, getOfflineStatus, getOfflineServerStatus);

export const useCanInstall = () => useSyncExternalStore(subscribeInstall, canInstall, () => false);

let nowCache = 0;
function subscribeNow(cb: () => void) {
  const id = window.setInterval(() => {
    nowCache = Date.now();
    cb();
  }, 60_000);
  return () => window.clearInterval(id);
}
function getNow() {
  if (!nowCache) nowCache = Date.now();
  return nowCache;
}
/** Current time, refreshed every minute (0 during prerender). */
export const useNow = () => useSyncExternalStore(subscribeNow, getNow, () => 0);

/** undefined = loading, null = user has no shop yet. */
export function useShopForUser(userId: string | null) {
  return useLiveQuery(
    async () => (userId ? ((await db.shops.where("ownerId").equals(userId).first()) ?? null) : null),
    [userId],
  );
}

export const useProducts = (shopId: string) =>
  useLiveQuery(() => db.products.where("shopId").equals(shopId).toArray(), [shopId]);

/** Latest stock moves of one product, newest first. */
export const useStockMoves = (productId: string, limit = 8) =>
  useLiveQuery(
    async () => (await db.stockMoves.where("productId").equals(productId).toArray()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
    [productId, limit],
  );

export const useCustomers = (shopId: string) =>
  useLiveQuery(() => db.customers.where("shopId").equals(shopId).toArray(), [shopId]);

export const useTodaySales = (shopId: string, now: number) =>
  useLiveQuery(
    async () =>
      (await db.sales.where("[shopId+day]").equals([shopId, dayKey(now)]).toArray()).sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    [shopId, now],
  );

export type TodayStats = DayStats;

/** Older bills that today's returns point at (their lines say whether the cost was known). */
export async function billsOf(corrections: { saleId: string }[], have: Sale[]) {
  const known = new Set(have.map((s) => s.id));
  const ids = [...new Set(corrections.map((c) => c.saleId).filter((id) => !known.has(id)))];
  const rows = ids.length ? await db.sales.bulkGet(ids) : [];
  return new Map(rows.filter((s): s is Sale => !!s).map((s) => [s.id, s]));
}

export function useTodayStats(shopId: string, now: number) {
  return useLiveQuery(async (): Promise<TodayStats> => {
    const day = dayKey(now);
    const sales = await db.sales.where("[shopId+day]").equals([shopId, day]).toArray();
    const corrections = await db.corrections.where("[shopId+day]").equals([shopId, day]).toArray();
    const start = startOfDayMs(now);
    const payments = await db.ledger
      .where("shopId")
      .equals(shopId)
      .filter((e) => e.type === "credit" && e.createdAt >= start)
      .toArray();
    return computeDayStats(sales, corrections, payments, await billsOf(corrections, sales));
  }, [shopId, now]);
}

export function useWeekTotals(shopId: string, now: number) {
  return useLiveQuery(async () => {
    const start = startOfDayMs(now) - 6 * DAY_MS;
    const sales = await db.sales.where("shopId").equals(shopId).filter((s) => s.createdAt >= start).toArray();
    const corrections = await db.corrections.where("shopId").equals(shopId).filter((c) => c.createdAt >= start).toArray();
    return Array.from({ length: 7 }, (_, i) => {
      const key = dayKey(start + i * DAY_MS + 3_600_000 * 12);
      return computeDayStats(
        sales.filter((s) => s.day === key),
        corrections.filter((c) => c.day === key),
        [],
      ).total;
    });
  }, [shopId, now]);
}

/** Live bill + its append-only correction history. */
export function useSaleWithCorrections(saleId: string | null) {
  return useLiveQuery(async () => {
    if (!saleId) return null;
    const sale = await db.sales.get(saleId);
    if (!sale) return null;
    const corrections = (await db.corrections.where("saleId").equals(saleId).toArray()).sort((a, b) => a.createdAt - b.createdAt);
    return { sale, corrections };
  }, [saleId]);
}

export function useAlerts(shop: Shop, now: number) {
  return useLiveQuery(
    async () =>
      computeAlerts(
        await db.products.where("shopId").equals(shop.id).toArray(),
        shop,
        now || Date.now(),
        await db.sales.where("shopId").equals(shop.id).filter((s) => pendingUpi(s) > 0).toArray(),
      ),
    [shop, now],
  );
}

/** Suppliers with money overdue or due within a few days (Home chip + /alerts). */
export const useSupplierDues = (shopId: string, now: number) =>
  useLiveQuery(() => loadSupplierDues(shopId, dayKey(now || Date.now())), [shopId, now]);

/** Changes of this shop still waiting for the server's confirmation. */
export const usePendingSync = (shopId: string) => useLiveQuery(() => pendingCount(shopId), [shopId]);
export const useCloudLink = () => useLiveQuery(async () => (await getCloudLink()) ?? null, []);
export const useSyncStatus = () => useLiveQuery(async () => (await getSyncStatus()) ?? null, []);
export const useSyncRunning = () => useSyncExternalStore(subscribeSyncRunning, isSyncRunning, () => false);

/** Customer (WhatsApp) orders still to pack / deliver, live — the small Home line. */
export const useOrderCounts = (shopId: string, now: number) =>
  useLiveQuery(async () => (now ? orderCounts(shopId, now) : null), [shopId, now]);

/** One day of the cash drawer (गल्ला), live. */
export const useCashDay = (shopId: string, day: string | null) =>
  useLiveQuery(async () => (day ? loadCashDay(shopId, day) : null), [shopId, day]);
export const useClosings = (shopId: string) => useLiveQuery(() => loadClosings(shopId), [shopId]);
