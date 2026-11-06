/**
 * Optional 4-digit app lock, per account, on this phone only.
 * The PIN is never stored: only a random salt + PBKDF2-SHA-256 hash (WebCrypto) in the local
 * `meta` table. Wrong attempts are counted on disk (a reload does not reset them) and, after a
 * few free tries, each further mistake doubles the wait. Forgetting the PIN never wipes data:
 * the account password removes the lock; without it the data stays on the phone untouched.
 */
import { delMeta, getMeta, setMeta } from "./meta";

export const PIN_ITERATIONS = 150_000;
export const FREE_ATTEMPTS = 5;
export const BASE_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 15 * 60_000;
/** Minutes in the background before the app locks again (0 = as soon as it is left). */
export const LOCK_AFTER_CHOICES = [0, 1, 5, 15, 30] as const;
export const DEFAULT_LOCK_AFTER = 1;

export interface PinRecord {
  v: 1;
  salt: string; // base64
  hash: string; // base64, 32 bytes
  iterations: number;
  failed: number;
  lockedUntil: number;
  lockAfterMin: number;
  updatedAt: number;
}

export class PinError extends Error {
  constructor(public code: "format" | "mismatch" | "noCrypto" | "none") {
    super(code);
  }
}

const key = (userId: string) => `pin:${userId}`;
export const isValidPin = (pin: string) => /^\d{4}$/.test(pin);

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new PinError("noCrypto");
  return s;
}
export const pinSupported = () => Boolean(globalThis.crypto?.subtle);

export async function hashPin(pin: string, salt: Uint8Array, iterations = PIN_ITERATIONS): Promise<Uint8Array> {
  const s = subtle();
  const material = await s.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await s.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, 256);
  return new Uint8Array(bits);
}

/** Constant-time comparison of two hashes. */
function same(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Wait before the next try after `failed` wrong PINs in a row (0 = may try now). */
export function backoffMs(failed: number) {
  if (failed < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** (failed - FREE_ATTEMPTS));
}

export const getPinRecord = (userId: string) => getMeta<PinRecord>(key(userId));
export async function hasPin(userId: string) {
  return Boolean(await getPinRecord(userId));
}

export async function setPin(userId: string, pin: string, opts: { lockAfterMin?: number; now?: number } = {}) {
  if (!isValidPin(pin)) throw new PinError("format");
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(pin, salt);
  const old = await getPinRecord(userId);
  const rec: PinRecord = {
    v: 1,
    salt: b64(salt),
    hash: b64(hash),
    iterations: PIN_ITERATIONS,
    failed: 0,
    lockedUntil: 0,
    lockAfterMin: opts.lockAfterMin ?? old?.lockAfterMin ?? DEFAULT_LOCK_AFTER,
    updatedAt: opts.now ?? Date.now(),
  };
  await setMeta(key(userId), rec);
  return rec;
}

export async function setLockAfter(userId: string, minutes: number) {
  const rec = await getPinRecord(userId);
  if (!rec) throw new PinError("none");
  await setMeta(key(userId), { ...rec, lockAfterMin: Math.max(0, Math.round(minutes)) });
}

export const removePin = (userId: string) => delMeta(key(userId));

export type VerifyResult = { ok: true } | { ok: false; waitMs: number; attemptsLeft: number; reason: "wrong" | "wait" | "none" };

/** Check a PIN. While a wait is running the PIN is not even tested (no free guesses). */
export async function verifyPin(userId: string, pin: string, now = Date.now()): Promise<VerifyResult> {
  const rec = await getPinRecord(userId);
  if (!rec) return { ok: false, waitMs: 0, attemptsLeft: 0, reason: "none" };
  if (rec.lockedUntil > now) return { ok: false, waitMs: rec.lockedUntil - now, attemptsLeft: 0, reason: "wait" };
  const hash = await hashPin(pin, unb64(rec.salt), rec.iterations);
  if (isValidPin(pin) && same(hash, unb64(rec.hash))) {
    if (rec.failed || rec.lockedUntil) await setMeta(key(userId), { ...rec, failed: 0, lockedUntil: 0 });
    return { ok: true };
  }
  const failed = rec.failed + 1;
  const wait = backoffMs(failed);
  await setMeta(key(userId), { ...rec, failed, lockedUntil: wait ? now + wait : 0 });
  return { ok: false, waitMs: wait, attemptsLeft: Math.max(0, FREE_ATTEMPTS - failed), reason: "wrong" };
}

/** Time left before another try is allowed (0 = now). */
export async function pinWaitMs(userId: string, now = Date.now()) {
  const rec = await getPinRecord(userId);
  return rec && rec.lockedUntil > now ? rec.lockedUntil - now : 0;
}
