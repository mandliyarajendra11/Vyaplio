"use client";

/**
 * App-lock state for the signed-in account: "checking" until the PIN record is read, then
 * "locked" (PIN set, app just opened or was in the background too long) or "open".
 * The state lives in memory only, so every fresh start of the app begins locked.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getPinRecord } from "./pin";

export type LockState = "checking" | "locked" | "open";

let current: { userId: string | null; state: LockState } = { userId: null, state: "checking" };
let hiddenAt: number | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (userId: string, state: LockState) => {
  current = { userId, state };
  emit();
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function check(userId: string) {
  current = { userId, state: "checking" };
  const rec = await getPinRecord(userId);
  if (current.userId === userId) set(userId, rec ? "locked" : "open");
}

/** Called after a correct PIN or the account password. */
export const unlockApp = (userId: string) => set(userId, "open");
/** "Lock now" button, or right after a PIN was set elsewhere and should apply. */
export const lockApp = (userId: string) => set(userId, "locked");
/** Re-read the PIN record (after it was set / removed in More). Keeps the app open. */
export async function refreshLock(userId: string) {
  const rec = await getPinRecord(userId);
  if (!rec) set(userId, "open");
}

/** Background timing: decide on return whether the app must lock again. */
export function shouldRelock(hiddenAtMs: number | null, nowMs: number, lockAfterMin: number) {
  if (hiddenAtMs === null) return false;
  return nowMs - hiddenAtMs >= lockAfterMin * 60_000;
}

export function useAppLock(userId: string | null): LockState {
  const state = useSyncExternalStore(
    subscribe,
    () => (userId && current.userId === userId ? current.state : "checking"),
    () => "checking" as LockState,
  );
  useEffect(() => {
    if (userId && current.userId !== userId) void check(userId);
  }, [userId]);
  useEffect(() => {
    if (!userId) return;
    const onVis = async () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const since = hiddenAt;
      hiddenAt = null;
      if (current.userId !== userId || current.state !== "open") return;
      const rec = await getPinRecord(userId);
      if (rec && shouldRelock(since, Date.now(), rec.lockAfterMin)) set(userId, "locked");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [userId]);
  return state;
}
