/**
 * Service-worker registration + "is this app ready to work without internet?" status.
 * The worker (public/sw.js) downloads every screen and asset of the current build into one cache
 * generation; `ready` turns true once that generation is complete.
 */
export type OfflineStatus = {
  /** "unsupported": no service worker (old browser / dev mode). */
  state: "unsupported" | "preparing" | "ready";
  updating: boolean;
  version?: string;
};

type SwMessage = { type?: string; ready?: boolean; updating?: boolean; version?: string };

const UNSUPPORTED: OfflineStatus = { state: "unsupported", updating: false };
let status: OfflineStatus = UNSUPPORTED;
const listeners = new Set<() => void>();
let started = false;

function set(next: OfflineStatus) {
  if (next.state === status.state && next.updating === status.updating && next.version === status.version) return;
  status = next;
  listeners.forEach((l) => l());
}

export const subscribeOffline = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
export const getOfflineStatus = () => status;
export const getOfflineServerStatus = () => UNSUPPORTED;

function ask(type: "status" | "check") {
  navigator.serviceWorker.controller?.postMessage({ type });
  void navigator.serviceWorker.ready.then((reg) => {
    if (reg.active && reg.active !== navigator.serviceWorker.controller) reg.active.postMessage({ type });
  });
}

/** Register the worker (production only) and keep `status` in sync with it. Idempotent. */
export function initOffline() {
  if (started || typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  started = true;
  const sw = navigator.serviceWorker;
  if (process.env.NODE_ENV !== "production") {
    // Avoid stale caches while developing.
    void sw.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
    return;
  }
  set({ state: "preparing", updating: true });
  sw.addEventListener("message", (e: MessageEvent<SwMessage>) => {
    if (e.data?.type !== "dm-sw-status") return;
    set({ state: e.data.ready ? "ready" : "preparing", updating: Boolean(e.data.updating), version: e.data.version });
  });
  sw.addEventListener("controllerchange", () => ask("status"));
  sw
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(() => ask("check"))
    .catch(() => set(UNSUPPORTED));
  window.addEventListener("online", () => ask("check"));
  // Ask the browser not to evict IndexedDB / caches under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
}
