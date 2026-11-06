import { db } from "./db";

/** Small device-local settings in the `meta` table (never synced, never in backup files). */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
export const setMeta = (key: string, value: unknown) => db.meta.put({ key, value });
export const delMeta = (key: string) => db.meta.delete(key);
