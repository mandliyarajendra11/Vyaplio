import type { Locale } from "./db";

const LOCALE_KEY = "dm-locale";
const SESSION_KEY = "dm-session";
const listeners = new Set<() => void>();

/** In-memory fallback when localStorage is unavailable (private mode, tests). */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) – keep in-memory only */
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCALE_KEY || e.key === SESSION_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export const getLocale = (): Locale => (read(LOCALE_KEY) === "en" ? "en" : "hi");
export const setLocale = (l: Locale) => write(LOCALE_KEY, l);
export const getSession = (): string | null => read(SESSION_KEY);
export const setSession = (userId: string | null) => write(SESSION_KEY, userId);
