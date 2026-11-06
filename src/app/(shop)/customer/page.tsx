"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { orderErrText, StatusBadge } from "@/components/OrderBits";
import { fmtDate } from "@/lib/dates";
import { db, type Customer, type Locale } from "@/lib/db";
import { useProducts } from "@/lib/hooks";
import { formatINR, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { netTotal, updateCustomer } from "@/lib/ops";
import { lastBillOf, liveBaskets, loadOrders, loadRepeatIntoCart, orderNo, orderTotal, planRepeat } from "@/lib/orders";
import { billNo } from "@/lib/billno";

export default function CustomerPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CustomerLoader />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function CustomerLoader() {
  const shop = useShop();
  const id = useSearchParams().get("id") ?? "";
  const tc = useTranslations("customer");
  const customer = useLiveQuery(async () => {
    const c = await db.customers.get(id);
    return c && c.shopId === shop.id ? c : null;
  }, [shop.id, id]);
  if (customer === undefined) return <Loading />;
  if (!customer) return <p className="text-lg">{tc("notFound")}</p>;
  return <CustomerView customer={customer} />;
}

function CustomerView({ customer }: { customer: Customer }) {
  const shop = useShop();
  const t = useTranslations();
  const tc = useTranslations("customer");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const saved = useSearchParams().get("saved");
  const products = useProducts(shop.id);
  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const baskets = useLiveQuery(async () => liveBaskets(await db.baskets.where("customerId").equals(customer.id).toArray()), [customer.id]);
  const lastBill = useLiveQuery(async () => (await lastBillOf(customer.id)) ?? null, [customer.id]);
  const orders = useLiveQuery(async () => (await loadOrders(shop.id)).filter((r) => r.order.customerId === customer.id).slice(0, 10), [shop.id, customer.id]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One tap: basket / last bill → the sale cart at today's prices (changes and shortages flagged there). */
  const toCart = async (src: { basketId: string } | { customerId: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await db.saleDrafts.get(shop.id);
      if (draft && Object.keys(draft.cart).length > 0 && !window.confirm(tc("replaceCart"))) return;
      const plan = await planRepeat(shop.id, src, locale);
      if (!plan.lines.length) return setError(tc("nothingToRepeat"));
      await loadRepeatIntoCart(shop.id, plan);
      router.push("/sale");
    } catch (e) {
      setError(orderErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const cid = encodeURIComponent(customer.id);
  return (
    <div className="space-y-6" data-testid="customer-page">
      <Link href={`/udhaar?customer=${cid}`} className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {t("nav.udhaar")}
      </Link>
      {saved && (
        <p role="status" className="rounded-xl bg-leaf/15 px-4 py-2 font-bold text-leaf" data-testid="customer-saved">
          {tc(saved === "deleted" ? "basketDeleted" : "basketSaved")}
        </p>
      )}
      <section>
        <h1 className="font-brand text-4xl font-semibold break-words" data-testid="customer-name">
          {customer.name}
        </h1>
        {customer.phone && (
          <a href={`tel:${customer.phone}`} className="num inline-block min-h-12 content-center text-lg text-teal">
            {customer.phone}
          </a>
        )}
        {(customer.address || customer.landmark) && (
          <p className="break-words text-ink-soft" data-testid="customer-address">
            {[customer.address, customer.landmark && tc("near", { landmark: customer.landmark })].filter(Boolean).join(" · ")}
          </p>
        )}
        <p className={`num mt-1 font-bold ${customer.balance > 0 ? "text-brick" : "text-leaf"}`}>
          {customer.balance > 0 ? tc("due", { amount: formatINR(customer.balance) }) : customer.balance < 0 ? tc("advance", { amount: formatINR(-customer.balance) }) : tc("clear")}
        </p>
        {!editing && (
          <button type="button" className="min-h-12 font-semibold text-teal underline" onClick={() => setEditing(true)} data-testid="customer-edit">
            {tc("edit")}
          </button>
        )}
        {editing && <EditCustomer customer={customer} onDone={() => setEditing(false)} />}
      </section>

      {error && (
        <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
          {error}
        </p>
      )}

      <section className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
        <button type="button" className="btn btn-primary min-h-[60px]" disabled={busy || !lastBill} onClick={() => toCart({ customerId: customer.id })} data-testid="customer-repeat-last">
          ↻ {tc("repeatLast")}
        </button>
        <Link href={`/orders/new?customer=${cid}`} className="btn btn-teal min-h-[60px]" data-testid="customer-new-order">
          {tc("newOrder")}
        </Link>
      </section>
      {lastBill && (
        <p className="num -mt-4 text-sm text-ink-soft">
          {tc("lastBill", { no: billNo(lastBill), date: fmtDate(lastBill.createdAt, locale), amount: formatINR(netTotal(lastBill)) })}
        </p>
      )}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-2xl font-bold">{tc("baskets")}</h2>
          <Link href={`/basket?customer=${cid}`} className="min-h-12 content-center font-bold text-teal" data-testid="basket-new">
            + {tc("newBasket")}
          </Link>
        </div>
        <p className="text-sm text-ink-soft">{tc("basketsHint")}</p>
        <ul className="mt-2 space-y-3" data-testid="basket-list">
          {(baskets ?? []).map((b) => {
            const est = round2(b.lines.reduce((a, l) => a + (l.amount ?? l.qty * (byId.get(l.productId)?.sellPrice ?? 0)), 0));
            return (
              <li key={b.id} className="card p-4" data-testid="basket-row">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xl font-bold break-words">🧺 {b.name}</p>
                  <p className="num font-bold">{formatINR(est)}</p>
                </div>
                <p className="line-clamp-2 text-sm text-ink-soft">{b.lines.map((l) => names(byId.get(l.productId) ?? l, locale).primary).join(", ")}</p>
                <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,6.5rem),1fr))] gap-2">
                  <button type="button" className="btn btn-primary min-h-[52px]" disabled={busy} onClick={() => toCart({ basketId: b.id })} data-testid="basket-to-bill">
                    {tc("toBill")}
                  </button>
                  <Link href={`/orders/new?customer=${cid}&basket=${encodeURIComponent(b.id)}`} className="btn btn-teal min-h-[52px]" data-testid="basket-to-order">
                    {tc("toOrder")}
                  </Link>
                  <Link href={`/basket?id=${encodeURIComponent(b.id)}`} className="btn btn-ghost min-h-[52px]" data-testid="basket-edit">
                    {tc("editBasket")}
                  </Link>
                </div>
              </li>
            );
          })}
          {baskets && baskets.length === 0 && <li className="py-4 text-ink-soft">{tc("noBaskets")}</li>}
        </ul>
      </section>

      <section>
        <h2 className="text-2xl font-bold">{tc("orders")}</h2>
        <ul className="ruled mt-2">
          {(orders ?? []).map((r) => (
            <li key={r.order.id}>
              <Link href={`/orders?id=${encodeURIComponent(r.order.id)}`} className="flex min-h-[60px] flex-wrap items-center justify-between gap-2 py-2">
                <span className="num font-semibold">
                  #{orderNo(r.order)} · {fmtDate(r.order.createdAt, locale)} · {formatINR(r.sale ? netTotal(r.sale) : orderTotal(r.order, byId))}
                </span>
                <StatusBadge status={r.state.status} />
              </Link>
            </li>
          ))}
          {orders && orders.length === 0 && <li className="py-4 text-ink-soft">{tc("noOrders")}</li>}
        </ul>
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
        <Link href={`/sales?range=all&customer=${cid}`} className="btn btn-ghost">
          {t("bills.customerBills")}
        </Link>
        <Link href={`/udhaar?customer=${cid}`} className="btn btn-ghost">
          {tc("udhaarBook")}
        </Link>
      </section>
    </div>
  );
}

function EditCustomer({ customer, onDone }: { customer: Customer; onDone: () => void }) {
  const t = useTranslations();
  const tc = useTranslations("customer");
  const [f, setF] = useState({ name: customer.name, phone: customer.phone ?? "", address: customer.address ?? "", landmark: customer.landmark ?? "" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async () => {
    if (!f.name.trim() || busy) return;
    setBusy(true);
    try {
      await updateCustomer(customer.id, f);
      onDone();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, mode?: "tel") => (
    <div>
      <label className="label" htmlFor={`ce-${k}`}>
        {label}
      </label>
      <input id={`ce-${k}`} className={`input ${mode ? "num" : ""}`} inputMode={mode} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`ce-${k}`} />
    </div>
  );
  return (
    <div className="card mt-3 space-y-3 p-4" data-testid="customer-edit-form">
      {field("name", tc("name"))}
      {field("phone", tc("phone"), "tel")}
      {field("address", tc("address"))}
      {field("landmark", tc("landmark"))}
      {failed && <p role="alert" className="font-semibold text-brick">{t("common.saveFailed")}</p>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !f.name.trim()} data-testid="ce-save">
          {busy ? t("common.saving") : t("common.save")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
