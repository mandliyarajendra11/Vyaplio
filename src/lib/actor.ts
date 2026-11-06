"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db, type Shop, type User } from "./db";
import { useSessionUser } from "./hooks";

/**
 * Name written into corrections / cash entries ("who"): the signed-in person's own name, then the
 * shop's owner name, then the account email's first part — never the shop's name.
 */
export function actorName(user: Pick<User, "email" | "displayName"> | null | undefined, shop: Pick<Shop, "ownerName">) {
  const own = user?.displayName?.trim();
  if (own) return own;
  if (shop.ownerName?.trim()) return shop.ownerName.trim();
  const local = user?.email?.split("@")[0]?.trim();
  return local || "—";
}

/** The signed-in user + the name to record, live. */
export function useActor(shop: Shop) {
  const userId = useSessionUser();
  const user = useLiveQuery(async () => (userId ? ((await db.users.get(userId)) ?? null) : null), [userId]);
  return { userId: userId ?? undefined, name: actorName(user, shop) };
}
