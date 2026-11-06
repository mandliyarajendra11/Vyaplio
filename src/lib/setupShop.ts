/**
 * Create the shop from the finished setup answers, in one transaction: shop row, the ticked
 * starter products (with an opening stock move when a quantity was given), the person's own
 * name for "who" records, and the draft is removed. Nothing is written if any part fails.
 */
import { v4 as uuid } from "uuid";
import { db, shopTables } from "./db";
import { clearDraft, productsFor, toShop, type OnboardState } from "./onboarding";
import { enqueue, saveProduct } from "./ops";

export async function finishOnboarding(st: OnboardState, userId: string, defaultName: string, now = Date.now()) {
  const shop = toShop(st, { shopId: uuid(), ownerId: userId }, defaultName, now);
  const products = productsFor(st);
  await db.transaction(
    "rw",
    [...shopTables(), db.users, db.meta],
    async () => {
      if (await db.shops.where("ownerId").equals(userId).first()) throw new Error("shop exists");
      await db.shops.add(shop);
      await enqueue("shops", "upsert", shop.id, shop);
      for (const p of products) await saveProduct(shop.id, p);
      const name = st.data.ownerName.trim();
      if (name) await db.users.update(userId, { displayName: name });
      await clearDraft(userId);
    },
  );
  return { shop, products: products.length };
}
