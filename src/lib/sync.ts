import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { db, type OutboxItem, type Sale, type SyncTable } from "./db";
import { round2 } from "./money";
import { getSession } from "./prefs";
import { getSupabase } from "./supabase/client";
import { SPECS, SYNC_ORDER, fromRemote, toRemote } from "./syncSchema";
import { ensureSupplierRecords } from "./suppliers";

/* ------------------------------------------------------------------ */
/* State kept in db.meta (travels with the phone's data)               */
/* ------------------------------------------------------------------ */

export interface CloudLink {
  localUserId: string;
  shopId: string;
  uid: string; // Supabase auth user id (shops.owner_id)
  email: string;
  linkedAt: number;
}
export type SyncErrorCode =
  | "notConfigured"
  | "offline"
  | "signedOut"
  | "notLinked"
  | "demo"
  | "noCloudShop"
  | "conflict"
  | "auth"
  | "denied"
  | "unconfirmed"
  | "network"
  | "server";
export interface SyncStatus {
  at: number;
  ok: boolean;
  pushed: number;
  pulled: number;
  error?: { code: SyncErrorCode; detail?: string };
}

export class SyncError extends Error {
  constructor(
    public code: SyncErrorCode,
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const LINK_KEY = "cloudLink";
const STATUS_KEY = "syncStatus";
const cursorKey = (shopId: string) => `pullCursor:${shopId}`;
const PAGE = 1000;
const CHUNK = 200;
const OVERLAP_MS = 2 * 60_000; // re-read a little behind the cursor: merges are idempotent

async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
const setMeta = (key: string, value: unknown) => db.meta.put({ key, value });

export const getCloudLink = () => getMeta<CloudLink>(LINK_KEY);
export const setCloudLink = (link: CloudLink | null) => (link ? setMeta(LINK_KEY, link) : db.meta.delete(LINK_KEY));
export const getSyncStatus = () => getMeta<SyncStatus>(STATUS_KEY);

/** Changes still waiting for the server, for one shop. */
export async function pendingCount(shopId?: string) {
  return shopId ? db.outbox.where("shopId").equals(shopId).count() : db.outbox.count();
}

/* "Sync running" flag for the UI (in memory). */
let running = false;
const listeners = new Set<() => void>();
export const subscribeSyncRunning = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
export const isSyncRunning = () => running;
const setRunning = (v: boolean) => {
  running = v;
  listeners.forEach((l) => l());
};

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

type Ctx = { sb: SupabaseClient; link: CloudLink; uid: string };

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function context(): Promise<Ctx> {
  const sb = getSupabase();
  if (!sb) throw new SyncError("notConfigured");
  const link = await getCloudLink();
  if (!link || link.localUserId !== getSession()) throw new SyncError("notLinked");
  if (isOffline()) throw new SyncError("offline");
  const { data } = await sb.auth.getSession();
  if (!data.session || data.session.user.id !== link.uid) throw new SyncError("signedOut");
  return { sb, link, uid: link.uid };
}

export function classify(err: Partial<PostgrestError> & { status?: number }, table?: string): SyncError {
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  const where = table ? `${table}: ` : "";
  if (code === "42501" || /row-level security/i.test(msg)) return new SyncError("denied", where + msg);
  if (code === "PGRST301" || code === "PGRST303" || /jwt|token|unauthori[sz]ed/i.test(msg)) return new SyncError("auth", where + msg);
  if (!code && /fetch|network|failed to|load failed|ECONN|timeout/i.test(msg)) return new SyncError("network", where + msg);
  return new SyncError("server", where + [code, msg].filter(Boolean).join(" "));
}

/* ------------------------------------------------------------------ */
/* Push: only rows the server returned are removed from the outbox     */
/* ------------------------------------------------------------------ */

async function push(ctx: Ctx): Promise<number> {
  const items = (await db.outbox.where("shopId").equals(ctx.link.shopId).toArray()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  let confirmedTotal = 0;
  for (const table of SYNC_ORDER) {
    const spec = SPECS[table];
    const latest = new Map<string, { item: OutboxItem; seqs: number[] }>();
    for (const it of items) {
      if (it.table !== table) continue;
      const g = latest.get(it.rowId) ?? { item: it, seqs: [] };
      g.item = it; // sorted by seq: last one wins (full row snapshot)
      g.seqs.push(it.seq as number);
      latest.set(it.rowId, g);
    }
    const ids = [...latest.keys()];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = chunk.map((id) => toRemote(table, latest.get(id)!.item.payload, ctx.uid));
      // Client-generated UUIDs make every write idempotent: a retry after a lost answer is harmless.
      // Append-only tables use INSERT ... ON CONFLICT DO NOTHING (insert-only RLS stays intact).
      const res = spec.appendOnly
        ? await ctx.sb.from(table).upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id")
        : await ctx.sb.from(table).upsert(rows, { onConflict: "id" }).select("id");
      if (res.error) throw classify({ ...res.error, status: res.status }, table);
      const confirmed = new Set((res.data ?? []).map((r: { id: string }) => r.id));
      const missing = chunk.filter((id) => !confirmed.has(id));
      if (missing.length && spec.appendOnly) {
        // "Do nothing" returns no row for duplicates: confirm they really exist on the server.
        const chk = await ctx.sb.from(table).select("id").in("id", missing);
        if (chk.error) throw classify({ ...chk.error, status: chk.status }, table);
        (chk.data ?? []).forEach((r: { id: string }) => confirmed.add(r.id));
      }
      const done = chunk.filter((id) => confirmed.has(id));
      await db.outbox.bulkDelete(done.flatMap((id) => latest.get(id)!.seqs));
      confirmedTotal += done.length;
      if (done.length < chunk.length) throw new SyncError("unconfirmed", `${table}: ${chunk.length - done.length}`);
    }
  }
  return confirmedTotal;
}

/* ------------------------------------------------------------------ */
/* Pull: initial (full) or incremental by server_updated_at            */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown> & { id: string };
const stamp = (r: Record<string, unknown> | undefined) => (r ? Number(r.updatedAt ?? r.createdAt ?? 0) : -1);

async function mergeRows(table: SyncTable, rows: Record<string, unknown>[], ownerId: string): Promise<number> {
  if (!rows.length) return 0;
  const spec = SPECS[table];
  const local = db.table(spec.local);
  const pending = new Set((await db.outbox.where("table").equals(table).toArray()).map((o) => o.rowId));
  let changed = 0;
  await db.transaction("rw", [local], async () => {
    for (const raw of rows) {
      const v = fromRemote(table, raw, ownerId) as Row;
      const cur = (await local.get(v.id)) as Row | undefined;
      if (spec.appendOnly) {
        if (!cur) {
          await local.add(v);
          changed++;
        }
        continue;
      }
      if (pending.has(v.id)) continue; // our newer local change goes up first; the server decides (LWW)
      if (table === "products" && v.deletedAt) {
        if (cur) {
          await local.delete(v.id);
          changed++;
        }
        continue;
      }
      if (cur && stamp(cur) > stamp(v)) continue; // last write wins by updatedAt
      let next: Row = v;
      if (cur && table === "products")
        next = { ...v, lastSoldAt: Math.max(Number(cur.lastSoldAt ?? 0), Number(v.lastSoldAt ?? 0)) || undefined, salesCount: Math.max(Number(cur.salesCount ?? 0), Number(v.salesCount ?? 0)) };
      if (cur && table === "customers") next = { ...v, lastPaidAt: Math.max(Number(cur.lastPaidAt ?? 0), Number(v.lastPaidAt ?? 0)) || undefined };
      if (table === "products") delete next.deletedAt;
      await local.put(next);
      changed++;
    }
  });
  return changed;
}

/**
 * Stock, udhaar and bill returns are derived from append-only history, so changes made on two
 * phones add up instead of overwriting each other.
 */
export async function recomputeDerived(shopId: string) {
  await db.transaction("rw", [db.products, db.customers, db.sales, db.stockMoves, db.ledger, db.corrections], async () => {
    const qty = new Map<string, number>();
    for (const m of await db.stockMoves.where("shopId").equals(shopId).toArray()) qty.set(m.productId, (qty.get(m.productId) ?? 0) + m.delta);
    for (const p of await db.products.where("shopId").equals(shopId).toArray()) {
      const q = round2(qty.get(p.id) ?? 0); // may be negative: a shortage stays visible
      if (q !== p.qty) await db.products.update(p.id, { qty: q });
    }
    const bal = new Map<string, number>();
    for (const e of await db.ledger.where("shopId").equals(shopId).toArray())
      bal.set(e.customerId, (bal.get(e.customerId) ?? 0) + (e.type === "debit" ? e.amount : -e.amount));
    for (const c of await db.customers.where("shopId").equals(shopId).toArray()) {
      const b = round2(bal.get(c.id) ?? 0);
      if (b !== c.balance) await db.customers.update(c.id, { balance: b });
    }
    const bySale = new Map<string, { amount: number; cost: number; qty: Map<number, number> }>();
    for (const c of await db.corrections.where("shopId").equals(shopId).toArray()) {
      const g = bySale.get(c.saleId) ?? { amount: 0, cost: 0, qty: new Map() };
      g.amount += c.amount;
      g.cost += c.cost;
      for (const l of c.lines) g.qty.set(l.index, (g.qty.get(l.index) ?? 0) + l.qty);
      bySale.set(c.saleId, g);
    }
    for (const [saleId, g] of bySale) {
      const s = await db.sales.get(saleId);
      if (!s) continue;
      const items = s.items.map((it, i) => (g.qty.has(i) ? { ...it, returnedQty: round2(g.qty.get(i)!) } : it));
      const allBack = items.every((it) => it.qty - (it.returnedQty ?? 0) <= 1e-9);
      const next: Sale = { ...s, items, returnedTotal: round2(g.amount), returnedCost: round2(g.cost), status: allBack ? "cancelled" : "partially_returned" };
      if (JSON.stringify(next) !== JSON.stringify(s)) await db.sales.put(next);
    }
  });
}

/** Pull the shop from the cloud. `full` ignores the cursor (first sign-in on a new phone). */
export async function pull(ctx: Ctx, opts: { full?: boolean; ownerId: string }): Promise<number> {
  const shopId = ctx.link.shopId;
  const since = opts.full ? undefined : await getMeta<string>(cursorKey(shopId));
  const from = since ? new Date(Date.parse(since) - OVERLAP_MS).toISOString() : undefined;
  let maxSeen = since ?? "";
  let changed = 0;
  for (const table of SYNC_ORDER) {
    for (let off = 0; ; off += PAGE) {
      let q = ctx.sb.from(table).select("*");
      q = table === "shops" ? q.eq("id", shopId) : q.eq("shop_id", shopId);
      if (from) q = q.gt("server_updated_at", from);
      const { data, error, status } = await q.order("server_updated_at", { ascending: true }).order("id", { ascending: true }).range(off, off + PAGE - 1);
      if (error) throw classify({ ...error, status }, table);
      const rows = (data ?? []) as Record<string, unknown>[];
      if (opts.full && table === "shops" && rows.length === 0) throw new SyncError("noCloudShop");
      changed += await mergeRows(table, rows, opts.ownerId);
      for (const r of rows) if (typeof r.server_updated_at === "string" && r.server_updated_at > maxSeen) maxSeen = r.server_updated_at;
      if (rows.length < PAGE) break;
    }
  }
  await recomputeDerived(shopId);
  // Phones on an older version only send free-text supplier names: give them supplier records.
  await ensureSupplierRecords(shopId);
  if (maxSeen) await setMeta(cursorKey(shopId), maxSeen);
  return changed;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export type SyncResult = { skipped: boolean; reason?: SyncErrorCode; pushed: number; pulled: number; pending: number; error?: SyncError };

let inFlight: Promise<SyncResult> | null = null;

/** Push queued changes, then pull other phones' changes. One run at a time. */
export function syncNow(opts: { full?: boolean } = {}): Promise<SyncResult> {
  if (!inFlight) inFlight = runSync(opts).finally(() => (inFlight = null));
  return inFlight;
}
/** Like syncNow, but never re-uses a run that started before the caller's change (e.g. linking). */
export async function syncFresh(opts: { full?: boolean } = {}): Promise<SyncResult> {
  if (inFlight) await inFlight.catch(() => undefined);
  return syncNow(opts);
}
/** Kept for callers of the old API. */
export const flushOutbox = () => syncNow();

const QUIET: SyncErrorCode[] = ["notConfigured", "notLinked", "offline"];

async function runSync(opts: { full?: boolean }): Promise<SyncResult> {
  let ctx: Ctx;
  try {
    ctx = await context();
  } catch (e) {
    const err = e instanceof SyncError ? e : new SyncError("server", String(e));
    if (!QUIET.includes(err.code)) await recordStatus({ ok: false, pushed: 0, pulled: 0, error: err });
    return { skipped: true, reason: err.code, pushed: 0, pulled: 0, pending: await pendingCount((await getCloudLink())?.shopId), error: err };
  }
  setRunning(true);
  let pushed = 0;
  let pulled = 0;
  try {
    pushed = await push(ctx);
    pulled = await pull(ctx, { full: opts.full, ownerId: ctx.link.localUserId });
    // The pull may have queued rows (supplier records for names from older phones): send them now.
    if (await pendingCount(ctx.link.shopId)) pushed += await push(ctx);
    await recordStatus({ ok: true, pushed, pulled });
    return { skipped: false, pushed, pulled, pending: await pendingCount(ctx.link.shopId) };
  } catch (e) {
    const err = e instanceof SyncError ? e : classify({ message: e instanceof Error ? e.message : String(e) });
    await recordStatus({ ok: false, pushed, pulled, error: err });
    return { skipped: false, pushed, pulled, pending: await pendingCount(ctx.link.shopId), error: err };
  } finally {
    setRunning(false);
  }
}

async function recordStatus(s: { ok: boolean; pushed: number; pulled: number; error?: SyncError }) {
  const status: SyncStatus = { at: Date.now(), ok: s.ok, pushed: s.pushed, pulled: s.pulled };
  if (s.error) status.error = { code: s.error.code, detail: s.error.detail };
  await setMeta(STATUS_KEY, status);
}

/** Context for cloud.ts (link / recovery), bypassing the "linked" check. */
export async function contextFor(link: CloudLink): Promise<Ctx> {
  const sb = getSupabase();
  if (!sb) throw new SyncError("notConfigured");
  if (isOffline()) throw new SyncError("offline");
  return { sb, link, uid: link.uid };
}
export { push as pushOutbox };

/**
 * Sync while the app is open: at start (changes from an earlier offline session), when the
 * connection returns, when the app is reopened, and every minute while visible.
 */
export function startAutoSync() {
  const run = () => void syncNow().catch(() => undefined);
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  run();
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") run();
  }, 60_000);
  return () => {
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}
