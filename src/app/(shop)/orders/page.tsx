"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconChevron, IconDownload, IconPlus, IconWhatsApp } from "@/components/Icons";
import { OrderBillSheet, orderErrText, StatusBadge } from "@/components/OrderBits";
import { Toast } from "@/components/Toast";
import { useActor } from "@/lib/actor";
import { billNo } from "@/lib/billno";
import { downloadCSV, toCSV } from "@/lib/csv";
import { dayKey, fmtDate } from "@/lib/dates";
import { db, type CustomerOrderLine, type Locale, type OrderStatus, type Product } from "@/lib/db";
import { useNow, useProducts } from "@/lib/hooks";
import { formatINR, formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { netTotal } from "@/lib/ops";
import {
  BASKETS_CSV_HEADERS,
  basketsCSVRows,
  billQty,
  billsOn,
  confirmText,
  isDone,
  isPending,
  loadOrders,
  NEXT,
  orderNo,
  ORDERS_CSV_HEADERS,
  ordersCSVRows,
  orderTotal,
  packingText,
  setOrderStatus,
  setPacking,
  statusText,
  validQty,
} from "@/lib/orders";
import { waLink } from "@/lib/whatsapp";

export default function OrdersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <OrdersInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function OrdersInner() {
  const id = useSearchParams().get("id");
  return id ? <OrderDetail key={id} id={id} /> : <OrderList />;
}

/* ------------------------------ list ------------------------------ */

const FILTERS = ["pending", "new", "packing", "ready", "out", "done", "cancelled", "all"] as const;
type Filter = (typeof FILTERS)[number];
const inFilter = (f: Filter, s: OrderStatus) =>
  f === "all" ? true : f === "pending" ? isPending(s) : f === "done" ? isDone(s) : s === f;

function OrderList() {
  const shop = useShop();
  const t = useTranslations();
  const to = useTranslations("orders");
  const locale = useLocale() as Locale;
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("status");
  const filter: Filter = (FILTERS as readonly string[]).includes(raw ?? "") ? (raw as Filter) : "pending";
  const rows = useLiveQuery(() => loadOrders(shop.id), [shop.id]);
  const products = useProducts(shop.id);
  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const now = useNow();
  const list = (rows ?? []).filter((r) => inFilter(filter, r.state.status));

  const exportCSV = async (kind: "orders" | "baskets") => {
    const stamp = now ? dayKey(now) : "orders";
    if (kind === "orders") downloadCSV(`customer-orders-${stamp}.csv`, toCSV(ORDERS_CSV_HEADERS, ordersCSVRows(rows ?? [])));
    else {
      const [baskets, customers] = await Promise.all([db.baskets.where("shopId").equals(shop.id).toArray(), db.customers.where("shopId").equals(shop.id).toArray()]);
      downloadCSV(`baskets-${stamp}.csv`, toCSV(BASKETS_CSV_HEADERS, basketsCSVRows(baskets, new Map(customers.map((c) => [c.id, c])), byId)));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-4xl font-semibold">{to("title")}</h1>
        <Link href="/orders/new" className="btn btn-primary" data-testid="orders-new">
          <IconPlus /> {to("new")}
        </Link>
      </div>
      <p className="text-ink-soft">{to("intro")}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={to("filterLabel")}>
        {FILTERS.map((f) => {
          const n = (rows ?? []).filter((r) => inFilter(f, r.state.status)).length;
          const on = f === filter;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              data-testid="orders-filter"
              data-filter={f}
              onClick={() => router.replace(f === "pending" ? "/orders" : `/orders?status=${f}`)}
              className={`inline-flex min-h-12 items-center gap-2 rounded-full border-2 px-4 font-bold ${on ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
            >
              {to(`filter_${f}`)}
              <span className={`num rounded-full px-2 text-sm ${on ? "bg-paper text-teal-deep" : "bg-paper-2 text-ink-soft"}`}>{n}</span>
            </button>
          );
        })}
      </div>
      <ul className="ruled" data-testid="orders-list">
        {list.map(({ order: o, state, customer, sale }) => (
          <li key={o.id}>
            <Link href={`/orders?id=${encodeURIComponent(o.id)}`} className="flex min-h-[76px] flex-wrap items-center gap-3 py-3" data-testid="order-row" data-status={state.status}>
              <span className="min-w-[min(100%,10rem)] flex-1">
                <span className="block text-xl font-bold break-words">{customer?.name ?? "—"}</span>
                <span className="num block text-sm text-ink-soft">
                  #{orderNo(o)} · {fmtDate(o.createdAt, locale, "d MMM, h:mm a")} · {to("rowItems", { count: o.lines.length, amount: formatINR(sale ? netTotal(sale) : orderTotal(o, byId)) })}
                </span>
              </span>
              <StatusBadge status={state.status} />
              <IconChevron className="shrink-0 text-ink-soft" />
            </Link>
          </li>
        ))}
        {rows && list.length === 0 && <li className="py-10 text-center text-lg text-ink-soft">{to("empty")}</li>}
      </ul>
      <section className="space-y-2">
        <h2 className="eyebrow">{to("exports")}</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2">
          {(["orders", "baskets"] as const).map((k) => (
            <button key={k} type="button" className="btn btn-ghost" onClick={() => exportCSV(k)} data-testid={`export-${k}`}>
              <IconDownload /> {to(`csv_${k}`)}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-soft">{t("orders.basketHint")}</p>
      </section>
    </div>
  );
}

/* ------------------------------ detail: packing view ------------------------------ */

function OrderDetail({ id }: { id: string }) {
  const shop = useShop();
  const t = useTranslations();
  const to = useTranslations("orders");
  const locale = useLocale() as Locale;
  const actor = useActor(shop);
  const products = useProducts(shop.id);
  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const data = useLiveQuery(async () => {
    const rows = await loadOrders(shop.id);
    const row = rows.find((r) => r.order.id === id) ?? null;
    const events = row ? (await db.orderEvents.where("orderId").equals(id).toArray()).sort((a, b) => a.createdAt - b.createdAt) : [];
    return { row, events };
  }, [shop.id, id]);
  const [billTo, setBillTo] = useState<OrderStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clearToast = useCallback(() => setToast(null), []);

  if (!data || !products) return <Loading />;
  if (!data.row) return <p className="text-lg">{to("notFound")}</p>;
  const { order: o, state, customer, sale } = data.row;
  const status = state.status;
  const editable = !state.saleId && (status === "new" || status === "packing");
  const total = sale ? netTotal(sale) : orderTotal(o, byId, true);
  const unticked = o.lines.filter((l) => !l.packed && l.packedQty === undefined).length;

  const move = async (next: OrderStatus) => {
    if (busy) return;
    if (next === "cancelled" && !window.confirm(to("cancelConfirm"))) return;
    if (next === "ready" && unticked > 0) {
      if (!window.confirm(to("untickedConfirm", { count: unticked }))) return;
      try {
        for (const [i, l] of o.lines.entries()) if (!l.packed && l.packedQty === undefined) await setPacking(o.id, i, { packedQty: 0 });
      } catch (e) {
        return setToast(orderErrText(t, e));
      }
    }
    if (billsOn(o.billAt, next) && !state.saleId) return setBillTo(next);
    setBusy(true);
    try {
      await setOrderStatus({ orderId: o.id, to: next, byName: actor.name });
      setToast(to(`moved_${next}`));
    } catch (e) {
      setToast(orderErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const phone = customer?.phone;
  const STEP_BTN: Partial<Record<OrderStatus, { key: string; cls: string }>> = {
    packing: { key: "startPacking", cls: "btn-primary" },
    ready: { key: "markReady", cls: "btn-primary" },
    out: { key: "markOut", cls: "btn-teal" },
    picked: { key: "markPicked", cls: "btn-ghost" },
    delivered: { key: "markDelivered", cls: "btn-primary" },
  };

  return (
    <div className="space-y-5" data-testid="order-detail">
      <Link href="/orders" className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {to("back")}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="num font-brand text-4xl font-semibold">{to("orderNo", { no: orderNo(o) })}</h1>
        <StatusBadge status={status} testId="order-status" />
      </div>

      <section className="card space-y-1 p-4" data-testid="order-customer">
        {customer ? (
          <Link href={`/customer?id=${encodeURIComponent(customer.id)}`} className="text-2xl font-bold break-words text-teal-deep underline">
            {customer.name}
          </Link>
        ) : (
          <p className="text-2xl font-bold">—</p>
        )}
        {phone && (
          <a href={`tel:${phone}`} className="num block min-h-12 content-center text-teal">
            {phone}
          </a>
        )}
        {customer?.address && <p className="break-words">{to("address", { address: customer.address })}</p>}
        {customer?.landmark && <p className="break-words text-ink-soft">{to("landmark", { landmark: customer.landmark })}</p>}
        <p className="pt-1 text-sm text-ink-soft">
          {fmtDate(o.createdAt, locale, "d MMM, h:mm a")} · {to(`from_${o.source}`)} · <b className="text-ink">{to(`billAt_${o.billAt}`)}</b>
        </p>
      </section>

      {state.saleId ? (
        <p className="rounded-xl bg-leaf/15 px-4 py-3 font-semibold text-leaf" data-testid="order-bill">
          {to("billed", { no: billNo({ id: state.saleId }), amount: formatINR(total) })}{" "}
          {customer && (
            <Link href={`/sales?range=all&customer=${encodeURIComponent(customer.id)}`} className="underline">
              {to("openBills")}
            </Link>
          )}
        </p>
      ) : (
        status !== "cancelled" && <p className="rounded-xl bg-paper-2 px-4 py-3 text-sm font-semibold">{to("notBilled")}</p>
      )}

      {o.unmatched && o.unmatched.length > 0 && (
        <section className="rounded-2xl border-2 border-mustard bg-mustard-soft/50 p-4" data-testid="order-unmatched">
          <p className="font-bold">{to("unmatchedTitle")}</p>
          <ul className="mt-1 list-disc pl-5">
            {o.unmatched.map((u, i) => (
              <li key={i} className="break-words">
                {u}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-2xl font-bold">{to("packTitleScreen")}</h2>
        {editable && <p className="text-sm text-ink-soft">{to("packHint")}</p>}
        <ul className="ruled mt-2" data-testid="packing-list">
          {o.lines.map((l, i) => (
            <PackLine key={`${l.productId}-${i}-${billQty(l)}`} orderId={o.id} index={i} line={l} product={byId.get(l.productId)} editable={editable} onError={(e) => setToast(orderErrText(t, e))} />
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-baseline justify-between border-t-2 border-ink/80 pt-3">
          <span className="text-lg font-bold">{sale ? t("sale.total") : to("estimate")}</span>
          <span className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] font-bold [overflow-wrap:anywhere]" data-testid="order-total">
            {formatINR(total)}
          </span>
        </div>
      </section>

      <section className="space-y-2" aria-label={to("actions")}>
        {NEXT[status]
          .filter((n) => n !== "cancelled")
          .map((n) => (
            <button key={n} type="button" className={`btn ${STEP_BTN[n]?.cls ?? "btn-ghost"} min-h-[60px] w-full text-lg`} disabled={busy} onClick={() => move(n)} data-testid={`order-to-${n}`}>
              {to(STEP_BTN[n]?.key ?? `status_${n}`)}
              {billsOn(o.billAt, n) && !state.saleId && <span className="text-sm font-semibold opacity-90"> · {to("andBill")}</span>}
            </button>
          ))}
      </section>

      <section className="space-y-2">
        <h2 className="eyebrow">WhatsApp</h2>
        {customer && isPending(status) && (
          <a href={waLink(confirmText(t, o, customer, shop, orderTotal(o, byId), locale), phone)} target="_blank" rel="noreferrer" className="btn btn-wa min-h-[56px] w-full" data-testid="wa-confirm">
            <IconWhatsApp /> {to("waConfirmBtn")}
          </a>
        )}
        {customer && status === "ready" && (
          <a href={waLink(statusText(t, "ready", o, customer, shop, total), phone)} target="_blank" rel="noreferrer" className="btn btn-wa min-h-[56px] w-full" data-testid="wa-ready">
            <IconWhatsApp /> {to("waReadyBtn")}
          </a>
        )}
        {customer && status === "out" && (
          <a href={waLink(statusText(t, "out", o, customer, shop, total), phone)} target="_blank" rel="noreferrer" className="btn btn-wa min-h-[56px] w-full" data-testid="wa-out">
            <IconWhatsApp /> {to("waOutBtn")}
          </a>
        )}
        {customer && (
          <a href={waLink(packingText(t, o, customer, locale))} target="_blank" rel="noreferrer" className="btn btn-ghost min-h-[56px] w-full" data-testid="wa-pack">
            <IconWhatsApp /> {to("waPackBtn")}
          </a>
        )}
        <p className="text-sm text-ink-soft">{phone ? to("waHint") : to("noPhone")}</p>
      </section>

      {NEXT[status].includes("cancelled") && !state.saleId && (
        <button type="button" className="min-h-12 font-semibold text-brick underline" onClick={() => move("cancelled")} disabled={busy} data-testid="order-cancel">
          {to("cancel")}
        </button>
      )}

      <section>
        <h2 className="eyebrow">{to("history")}</h2>
        <ul className="mt-1 text-sm text-ink-soft" data-testid="order-history">
          {data.events.map((e) => (
            <li key={e.id} className="num py-1">
              {fmtDate(e.createdAt, locale, "d MMM, h:mm a")} · {e.type === "bill" ? to("historyBill") : to(`status_${e.status}`)}
              {e.byName && <> · {e.byName}</>}
            </li>
          ))}
        </ul>
      </section>

      {billTo && (
        <OrderBillSheet
          shop={shop}
          order={o}
          customer={customer}
          to={billTo}
          products={products}
          onClose={() => setBillTo(null)}
          onDone={() => {
            setBillTo(null);
            setToast(to("billedToast"));
          }}
        />
      )}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

function PackLine({ orderId, index, line, product, editable, onError }: { orderId: string; index: number; line: CustomerOrderLine; product?: Product; editable: boolean; onError: (e: unknown) => void }) {
  const t = useTranslations();
  const to = useTranslations("orders");
  const locale = useLocale() as Locale;
  const unit = t(`unit.${line.unit}`);
  const shown = billQty(line);
  // The row is keyed by the saved quantity, so a change from another phone resets this field.
  const [text, setText] = useState(formatQty(shown));
  const name = names(line, locale).primary;
  const q = Number(text.replace(",", "."));
  const bad = text.trim() === "" || !validQty(q, line.unit, true);
  const save = async (patch: { packed?: boolean; packedQty?: number | null }) => {
    try {
      await setPacking(orderId, index, patch);
    } catch (e) {
      onError(e);
    }
  };
  const commitQty = () => {
    if (bad || q === shown) return;
    void save({ packedQty: q === line.qty ? null : q });
  };
  const short = product && shown > Math.max(0, product.qty);
  return (
    <li className="flex flex-wrap items-center gap-3 py-3" data-testid="pack-line" data-packed={line.packed ? "1" : "0"}>
      <label className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3">
        <input
          type="checkbox"
          className="h-7 w-7 shrink-0 accent-teal"
          checked={!!line.packed}
          disabled={!editable}
          onChange={(e) => save({ packed: e.target.checked })}
          aria-label={to("packedFor", { name })}
          data-testid="pack-tick"
        />
        <span className="min-w-0">
          <span className={`block text-lg font-bold break-words ${line.packed ? "text-leaf" : ""}`}>{name}</span>
          <span className="num block text-sm text-ink-soft">
            {line.amount !== undefined ? to("askedAmount", { amount: formatINR(line.amount), qty: `${formatNum(line.qty)} ${unit}` }) : to("askedQty", { qty: `${formatNum(line.qty)} ${unit}` })}
            {product && product.sellPrice !== line.price && <> · {to("priceChanged", { old: formatINR(line.price), now: formatINR(product.sellPrice) })}</>}
          </span>
          {!product && <span className="block text-sm font-semibold text-brick">{to("productGone")}</span>}
          {short && <span className="num block text-sm font-semibold text-mustard-ink">{to("stockShort", { qty: `${formatNum(product!.qty)} ${unit}` })}</span>}
        </span>
      </label>
      <label className="flex shrink-0 items-center gap-2">
        <span className="sr-only">{to("packedQtyFor", { name })}</span>
        <input
          className={`input num w-24 text-center ${bad ? "border-brick" : ""}`}
          inputMode="decimal"
          value={text}
          disabled={!editable}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitQty}
          onKeyDown={(e) => e.key === "Enter" && commitQty()}
          aria-label={to("packedQtyFor", { name })}
          data-testid="pack-qty"
        />
        <span className="font-semibold">{unit}</span>
      </label>
    </li>
  );
}

const formatQty = (n: number) => String(Math.round(n * 100) / 100);
