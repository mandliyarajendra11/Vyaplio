/**
 * Assisted shop setup: one question per screen, every step skippable with a sensible default,
 * saved after each answer (device-local `meta` row per account) so closing the app midway
 * resumes at the same question. Pure functions here; the screen lives in app/setup.
 * The PIN itself is never part of this draft — the PIN step stores only a salted hash (pin.ts).
 */
import type { Locale, Shop } from "./db";
import { delMeta, getMeta, setMeta } from "./meta";
import { isShopType, starterProducts, type PickedItem, type ShopType } from "./starter";

export const STEPS = ["language", "shopName", "ownerName", "phone", "shopType", "products", "upi", "pin", "safety"] as const;
export type Step = (typeof STEPS)[number];

export interface OnboardData {
  language: Locale;
  shopName: string;
  ownerName: string;
  phone: string;
  shopType: ShopType;
  picked: Record<string, PickedItem>;
  upiId: string;
  pinSet: boolean;
}

export interface OnboardState {
  v: 1;
  step: Step;
  data: OnboardData;
  skipped: Step[];
  startedAt: number;
  updatedAt: number;
}

export type StepError = "shopNameShort" | "phone" | "upi";

export function initialState(language: Locale, now = Date.now()): OnboardState {
  return {
    v: 1,
    step: "language",
    data: { language, shopName: "", ownerName: "", phone: "", shopType: "kirana", picked: {}, upiId: "", pinSet: false },
    skipped: [],
    startedAt: now,
    updatedAt: now,
  };
}

export const stepIndex = (s: Step) => STEPS.indexOf(s);
export const progress = (st: OnboardState) => ({ index: stepIndex(st.step) + 1, total: STEPS.length });
export const isLast = (st: OnboardState) => stepIndex(st.step) === STEPS.length - 1;

/** Indian mobile: 10 digits starting 6-9, optional +91 / 0 prefix. Empty is fine (optional). */
export function cleanPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (!d) return "";
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

/** UPI VPA: handle@bank, e.g. ramu.kirana@okicici / 9876543210@ybl. Empty is fine (optional). */
export const UPI_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
export function cleanUpi(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "";
  return UPI_RE.test(v) ? v.toLowerCase() : null;
}

export function validate(step: Step, d: OnboardData): StepError | null {
  if (step === "shopName" && d.shopName.trim().length < 2) return "shopNameShort";
  if (step === "phone" && cleanPhone(d.phone) === null) return "phone";
  if (step === "upi" && cleanUpi(d.upiId) === null) return "upi";
  return null;
}

const move = (st: OnboardState, by: 1 | -1, now: number): OnboardState => {
  const i = Math.min(STEPS.length - 1, Math.max(0, stepIndex(st.step) + by));
  return { ...st, step: STEPS[i], updatedAt: now };
};

/** Answer the current question and go on. Returns the error instead when the answer is not valid. */
export function next(st: OnboardState, patch: Partial<OnboardData> = {}, now = Date.now()): { state: OnboardState; error: StepError | null } {
  const data = { ...st.data, ...patch };
  const error = validate(st.step, data);
  if (error) return { state: { ...st, data }, error };
  return { state: move({ ...st, data, skipped: st.skipped.filter((s) => s !== st.step) }, 1, now), error: null };
}

/** The default each skipped question gets (the shop name is filled in at finish). */
export function defaultsFor(step: Step): Partial<OnboardData> {
  switch (step) {
    case "shopName":
      return { shopName: "" };
    case "ownerName":
      return { ownerName: "" };
    case "phone":
      return { phone: "" };
    case "shopType":
      return { shopType: "kirana" };
    case "products":
      return { picked: {} };
    case "upi":
      return { upiId: "" };
    default:
      return {};
  }
}

export function skip(st: OnboardState, now = Date.now()): OnboardState {
  const data = { ...st.data, ...defaultsFor(st.step) };
  const skipped = st.skipped.includes(st.step) ? st.skipped : [...st.skipped, st.step];
  return move({ ...st, data, skipped }, 1, now);
}

export const back = (st: OnboardState, now = Date.now()) => move(st, -1, now);

/** The shop row the finished answers create. `defaultName` is the localised "My shop". */
export function toShop(st: OnboardState, ids: { shopId: string; ownerId: string }, defaultName: string, now = Date.now()): Shop {
  const d = st.data;
  return {
    id: ids.shopId,
    ownerId: ids.ownerId,
    name: d.shopName.trim() || defaultName,
    ownerName: d.ownerName.trim(),
    phone: cleanPhone(d.phone) || undefined,
    upiId: cleanUpi(d.upiId) || undefined,
    language: d.language,
    deadStockDays: 30,
    expiryWarnDays: 7,
    createdAt: now,
    updatedAt: now,
  };
}

export const productsFor = (st: OnboardState) => starterProducts(st.data.shopType, st.data.picked);

/** Parse a saved draft defensively (older / damaged rows start over instead of crashing). */
export function revive(raw: unknown): OnboardState | null {
  const st = raw as OnboardState | null;
  if (!st || st.v !== 1 || !STEPS.includes(st.step) || typeof st.data !== "object" || !st.data) return null;
  const d = st.data;
  return {
    ...st,
    skipped: Array.isArray(st.skipped) ? st.skipped.filter((s) => STEPS.includes(s)) : [],
    data: {
      language: d.language === "en" ? "en" : "hi",
      shopName: String(d.shopName ?? ""),
      ownerName: String(d.ownerName ?? ""),
      phone: String(d.phone ?? ""),
      shopType: isShopType(d.shopType) ? d.shopType : "kirana",
      picked: d.picked && typeof d.picked === "object" ? d.picked : {},
      upiId: String(d.upiId ?? ""),
      pinSet: Boolean(d.pinSet),
    },
  };
}

const key = (userId: string) => `onboard:${userId}`;
export const loadDraft = async (userId: string) => revive(await getMeta(key(userId)));
export const saveDraft = (userId: string, st: OnboardState) => setMeta(key(userId), st);
export const clearDraft = (userId: string) => delMeta(key(userId));
