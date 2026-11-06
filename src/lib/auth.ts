import { v4 as uuid } from "uuid";
import { db } from "./db";
import { setLocale, setSession } from "./prefs";

async function hash(password: string): Promise<string> {
  const data = new TextEncoder().encode(`dukaanmitra:${password}`);
  if (globalThis.crypto?.subtle) {
    const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
    return "sha256:" + Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for insecure (http LAN) contexts where SubtleCrypto is unavailable.
  let h = 0x811c9dc5;
  for (const b of data) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "fnv:" + h.toString(16);
}

export class AuthError extends Error {
  constructor(public code: "invalid" | "exists" | "short") {
    super(code);
  }
}

const norm = (email: string) => email.trim().toLowerCase();

export async function register(email: string, password: string) {
  if (password.length < 6) throw new AuthError("short");
  const e = norm(email);
  if (await db.users.where("email").equals(e).first()) throw new AuthError("exists");
  const user = { id: uuid(), email: e, passHash: await hash(password), createdAt: Date.now() };
  await db.users.add(user);
  setSession(user.id);
  return user;
}

export async function login(email: string, password: string) {
  const user = await db.users.where("email").equals(norm(email)).first();
  if (!user) throw new AuthError("invalid");
  if (user.passHash !== (await hash(password))) throw new AuthError("invalid");
  const shop = await db.shops.where("ownerId").equals(user.id).first();
  if (shop) setLocale(shop.language);
  setSession(user.id);
  return user;
}

/** Check the account password of the signed-in user (PIN reset). Never changes anything. */
export async function verifyPassword(userId: string, password: string) {
  const user = await db.users.get(userId);
  return Boolean(user && password && user.passHash === (await hash(password)));
}

/** The person's own name for "who did this" records. */
export async function setDisplayName(userId: string, name: string) {
  const n = name.trim();
  if (n) await db.users.update(userId, { displayName: n });
}

export function logout() {
  setSession(null);
}

/**
 * Local account for a cloud sign-in on this phone (new phone recovery). Re-uses the account
 * with this email if it exists (password must match), otherwise creates it with the same password,
 * so the owner can also sign in here without internet later.
 */
export async function ensureLocalUser(email: string, password: string) {
  const e = norm(email);
  const existing = await db.users.where("email").equals(e).first();
  if (existing) {
    if (existing.passHash !== (await hash(password))) throw new AuthError("invalid");
    return existing;
  }
  const user = { id: uuid(), email: e, passHash: await hash(password), createdAt: Date.now() };
  await db.users.add(user);
  return user;
}

/** Only call after a verified cloud OTP has identified the owner of the shop. */
export async function ensureLocalUserAfterPhoneRecovery(email: string, password: string) {
  if (password.length < 6) throw new AuthError("short");
  const e = norm(email);
  const existing = await db.users.where("email").equals(e).first();
  if (existing) {
    await db.users.update(existing.id, { passHash: await hash(password) });
    return existing;
  }
  const user = { id: uuid(), email: e, passHash: await hash(password), createdAt: Date.now() };
  await db.users.add(user);
  return user;
}
