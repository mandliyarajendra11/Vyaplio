/**
 * "Backup reminder": when did this shop last get a copy off the phone (a backup file that was
 * shared / saved, or a successful cloud sync of this shop), and is a nudge due?
 * All device-local (`meta`), nothing synced.
 */
import { DAY_MS } from "./dates";
import { getMeta, setMeta } from "./meta";
import { getCloudLink, getSyncStatus } from "./sync";

export const REMIND_CHOICES = [3, 7, 14, 30] as const;
export const DEFAULT_REMIND_DAYS = 7;
export const SNOOZE_MS = DAY_MS;

export interface RemindSettings {
  days: number;
  snoozedUntil?: number;
}

const lastKey = (shopId: string) => `lastBackup:${shopId}`;
const remindKey = (shopId: string) => `backupRemind:${shopId}`;

export const markBackup = (shopId: string, at = Date.now()) => setMeta(lastKey(shopId), at);
export const getLastFileBackup = (shopId: string) => getMeta<number>(lastKey(shopId));
export async function getRemindSettings(shopId: string): Promise<RemindSettings> {
  const s = await getMeta<RemindSettings>(remindKey(shopId));
  return { days: s?.days && s.days > 0 ? s.days : DEFAULT_REMIND_DAYS, snoozedUntil: s?.snoozedUntil };
}
export async function setRemindDays(shopId: string, days: number) {
  await setMeta(remindKey(shopId), { ...(await getRemindSettings(shopId)), days: Math.max(1, Math.round(days)) });
}
export async function snoozeReminder(shopId: string, now = Date.now()) {
  await setMeta(remindKey(shopId), { ...(await getRemindSettings(shopId)), snoozedUntil: now + SNOOZE_MS });
}

export interface BackupState {
  /** Latest copy off the phone (file or cloud), if any. */
  lastAt: number | null;
  via: "file" | "cloud" | null;
  /** Whole days since the last copy, or since the shop was created when there never was one. */
  days: number;
  due: boolean;
}

export function backupState(o: {
  lastFileAt?: number | null;
  lastCloudAt?: number | null;
  shopCreatedAt: number;
  isDemo?: boolean;
  remindDays: number;
  snoozedUntil?: number;
  now: number;
}): BackupState {
  const file = o.lastFileAt ?? null;
  const cloud = o.lastCloudAt ?? null;
  const lastAt = file !== null || cloud !== null ? Math.max(file ?? 0, cloud ?? 0) : null;
  const via = lastAt === null ? null : lastAt === cloud ? "cloud" : "file";
  const days = Math.max(0, Math.floor((o.now - (lastAt ?? o.shopCreatedAt)) / DAY_MS));
  const due = !o.isDemo && days >= o.remindDays && !(o.snoozedUntil && o.snoozedUntil > o.now);
  return { lastAt, via, days, due };
}

/** Everything backupState() needs, read from this phone. */
export async function loadBackupState(shop: { id: string; createdAt: number; isDemo?: boolean }, now = Date.now()) {
  const [lastFileAt, link, status, s] = await Promise.all([getLastFileBackup(shop.id), getCloudLink(), getSyncStatus(), getRemindSettings(shop.id)]);
  const lastCloudAt = link?.shopId === shop.id && status?.ok ? status.at : null;
  return { ...backupState({ lastFileAt, lastCloudAt, shopCreatedAt: shop.createdAt, isDemo: shop.isDemo, remindDays: s.days, snoozedUntil: s.snoozedUntil, now }), remindDays: s.days };
}
