import { AuthError, ensureLocalUser } from "./auth";
import { restoreBackup, type BackupData } from "./backup";
import { db } from "./db";
import { setLocale, setSession } from "./prefs";

/** A validated backup can restore an existing shop without creating a blank free shop. */
export async function recoverFromBackup(data: BackupData, email: string, password: string) {
  if (password.length < 6) throw new AuthError("short");
  const normalized = email.trim().toLowerCase();
  const existing = await db.users.where("email").equals(normalized).first();
  if (existing && await db.shops.where("ownerId").equals(existing.id).first()) throw new AuthError("exists");
  const user = await ensureLocalUser(normalized, password);
  try {
    await restoreBackup(data, user.id);
  } catch (error) {
    if (!existing && !(await db.shops.where("ownerId").equals(user.id).first())) await db.users.delete(user.id);
    throw error;
  }
  setLocale(data.shop.language);
  setSession(user.id);
  return user;
}
