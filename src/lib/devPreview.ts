import { ensureLocalUser } from "./auth";
import { db } from "./db";
import { setLocale, setSession } from "./prefs";
import { DEMO_SHOP_ID, seedDemo } from "./seed";

/** Local developer preview only. Never grants a paid account or cloud/admin access. */
export async function openLocalPreview() {
  if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    throw new Error("preview_unavailable");
  }
  const oldShop = await db.shops.get(DEMO_SHOP_ID);
  if (oldShop && await db.users.get(oldShop.ownerId)) {
    setLocale(oldShop.language);
    setSession(oldShop.ownerId);
    return oldShop.ownerId;
  }
  const user = await ensureLocalUser(`preview-${crypto.randomUUID()}@local.invalid`, crypto.randomUUID());
  try {
    const shop = await seedDemo(user.id);
    setLocale(shop.language);
    setSession(user.id);
    return user.id;
  } catch (error) {
    await db.users.delete(user.id);
    throw error;
  }
}
