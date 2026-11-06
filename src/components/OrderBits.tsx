"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { PaymentPanel, type UpiChoice } from "@/components/PaymentPanel";
import { Sheet } from "@/components/Sheet";
import { useActor } from "@/lib/actor";
import type { Customer, CustomerOrder, Locale, OrderStatus, PaymentType, Product, Sale, Shop } from "@/lib/db";
import { formatINR, formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { basketFromSale, billPreview, OrderError, setOrderStatus } from "@/lib/orders";
import { formPlan, PAY_METHODS, PaymentError, type PaymentRequest, type SplitForm } from "@/lib/payments";
import { buildIndex, searchIndex } from "@/lib/search";

type T = ReturnType<typeof useTranslations>;

export function orderErrText(t: T, e: unknown) {
  if (e instanceof OrderError) return t(`orders.err_${e.code}`);
  if (e instanceof PaymentError) return t(e.code === "customer" ? "pay.errCustomer" : e.code === "tendered" ? "pay.errTendered" : e.code === "upiChoice" ? "pay.upiChoose" : "pay.errSum");
  return t("common.saveFailed");
}

const BADGE: Record<OrderStatus, string> = {
  new: "bg-mustard text-ink",
  packing: "bg-mustard-soft text-mustard-ink",
  ready: "bg-teal text-paper",
  out: "bg-teal-deep text-paper",
  picked: "bg-leaf text-paper",
  delivered: "bg-leaf text-paper",
  cancelled: "bg-paper-2 text-ink-soft line-through",
};

export function StatusBadge({ status, testId }: { status: OrderStatus; testId?: string }) {
  const t = useTranslations("orders");
  return (
    <span className={`inline-block shrink-0 rounded-full px-3 py-1 text-sm font-extrabold ${BADGE[status]}`} data-testid={testId} data-status={status}>
      {t(`status_${status}`)}
    </span>
  );
}

/** Product search that adds a line (used by the basket editor and the new-order form). */
export function ProductAdder({ products, exclude, onPick, label, testId }: { products: Product[]; exclude: Set<string>; onPick: (p: Product) => void; label: string; testId?: string }) {
  const t = useTranslations("orders");
  const locale = useLocale() as Locale;
  const [q, setQ] = useState("");
  const index = useMemo(() => buildIndex(products), [products]);
  const hits = q.trim() ? searchIndex(index, q, { limit: 6 }).map((h) => h.product).filter((p) => !exclude.has(p.id)) : [];
  return (
    <div>
      <label className="label" htmlFor={`${testId ?? "adder"}-q`}>
        {label}
      </label>
      <input id={`${testId ?? "adder"}-q`} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchPh")} autoComplete="off" data-testid={testId} />
      {hits.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {hits.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-ghost min-h-[48px]"
              data-testid={testId ? `${testId}-hit` : undefined}
              onClick={() => {
                onPick(p);
                setQ("");
              }}
            >
              + {names(p, locale).primary}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The order's bill (its billing point was reached): packed quantities at today's prices, then the
 * normal payment block (cash / UPI / udhaar / split). Udhaar goes to the order's customer.
 */
export function OrderBillSheet({
  shop,
  order,
  customer,
  to,
  products,
  onClose,
  onDone,
}: {
  shop: Shop;
  order: CustomerOrder;
  customer?: Customer;
  to: OrderStatus;
  products: Product[];
  onClose: () => void;
  onDone: (sale?: Sale) => void;
}) {
  const t = useTranslations();
  const to_ = useTranslations("orders");
  const locale = useLocale() as Locale;
  const actor = useActor(shop);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const preview = billPreview(order, byId);
  const total = preview.total;
  const [payment, setPayment] = useState<PaymentType>("cash");
  const [split, setSplit] = useState<SplitForm | null>(null);
  const [tendered, setTendered] = useState("");
  const [upi, setUpi] = useState<UpiChoice>(null);
  const [upiRef, setUpiRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = formPlan(total, payment, split);
  const upiReady = plan.amounts.upi <= 0 || (!!upi && upi.amount === plan.amounts.upi);

  const confirm = async () => {
    if (busy) return;
    if (plan.invalid || Math.abs(plan.left) > 0.005) return setError(t("pay.errSum"));
    const tenderedNum = tendered.trim() ? Number(tendered) : undefined;
    if (tenderedNum !== undefined && plan.amounts.cash > 0 && !(tenderedNum >= plan.amounts.cash)) return setError(t("pay.errTendered"));
    if (!upiReady) return setError(t("pay.upiChoose"));
    const payments: PaymentRequest[] = PAY_METHODS.filter((m) => plan.amounts[m] > 0).map((m) => ({
      method: m,
      amount: plan.amounts[m],
      tendered: m === "cash" ? tenderedNum : undefined,
      upi: m === "upi" ? upi?.state : undefined,
      ref: m === "upi" && upi?.state === "paid" ? upiRef : undefined,
    }));
    setBusy(true);
    setError(null);
    try {
      const r = await setOrderStatus({ orderId: order.id, to, pay: { payment, payments: payments.length ? payments : undefined }, byName: actor.name });
      onDone(r.sale);
    } catch (e) {
      setError(orderErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={to_("billTitle")}
      footer={
        <div>
          {!upiReady && <p className="mb-2 text-center text-sm font-semibold text-mustard-ink">{t("pay.upiChoose")}</p>}
          <button type="button" className="btn btn-primary min-h-[64px] w-full text-xl" onClick={confirm} disabled={busy || !preview.lines.length} data-testid="order-bill-confirm">
            {busy ? t("common.saving") : to_("billConfirm", { amount: formatINR(total) })}
          </button>
        </div>
      }
    >
      <div data-testid="order-bill-sheet">
        <p className="text-ink-soft">{to_("billHint")}</p>
        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
            {error}
          </p>
        )}
        <fieldset disabled={busy} className="min-w-0">
          <ul className="ruled mt-2">
            {preview.lines.map(({ line, product: p, qty }) => (
              <li key={p.id} className="py-2">
                <p className="font-bold break-words">{names(p, locale).primary}</p>
                <p className="num text-ink-soft">
                  {formatINR(p.sellPrice)} × {formatNum(qty)} {t(`unit.${p.unit}`)} = <b className="text-ink">{formatINR(qty * p.sellPrice)}</b>
                  {line.price !== p.sellPrice && <span className="ml-2 font-semibold text-mustard-ink">{to_("priceChanged", { old: formatINR(line.price), now: formatINR(p.sellPrice) })}</span>}
                  {qty > Math.max(0, p.qty) && <span className="ml-2 font-semibold text-mustard-ink">{t("sale.overStock")}</span>}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-baseline justify-between border-t-2 border-ink/80 pt-3">
            <span className="text-lg font-bold">{t("sale.total")}</span>
            <span className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] font-bold [overflow-wrap:anywhere]" data-testid="order-bill-total">
              {formatINR(total)}
            </span>
          </div>
          <PaymentPanel
            shop={shop}
            total={total}
            payment={payment}
            split={split}
            onPayment={setPayment}
            onSplit={setSplit}
            tendered={tendered}
            onTendered={setTendered}
            upi={upi}
            onUpi={setUpi}
            upiRef={upiRef}
            onUpiRef={setUpiRef}
          />
          {plan.amounts.credit > 0 && customer && <p className="mt-3 rounded-xl bg-paper-2 px-4 py-2 font-semibold">{to_("creditTo", { name: customer.name })}</p>}
        </fieldset>
      </div>
    </Sheet>
  );
}

/**
 * "Save as basket" on a bill: the bill's remaining quantities become a named basket for its customer
 * (a bill without a customer asks which customer it belongs to).
 */
export function SaveBasket({ sale, customers }: { sale: Sale; customers: Customer[] }) {
  const t = useTranslations();
  const tb = useTranslations("basket");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cid, setCid] = useState(sale.customerId ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open)
    return (
      <>
        <button type="button" className="btn btn-ghost mt-3 w-full" onClick={() => { setOpen(true); setMsg(null); }} data-testid="save-basket">
          🧺 {tb("saveFromBill")}
        </button>
        {msg && (
          <p role="status" className="mt-2 font-semibold text-leaf" data-testid="save-basket-done">
            {msg.text}
          </p>
        )}
      </>
    );
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const b = await basketFromSale(sale.id, name, cid || undefined);
      setOpen(false);
      setName("");
      setMsg({ ok: true, text: tb("savedAs", { name: b.name }) });
    } catch (e) {
      setMsg({ ok: false, text: orderErrText(t, e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mt-3 space-y-3 p-4" data-testid="save-basket-form">
      <p className="font-bold">🧺 {tb("saveFromBill")}</p>
      <p className="text-sm text-ink-soft">{tb("saveFromBillHint")}</p>
      {!sale.customerId && (
        <select className="input" value={cid} onChange={(e) => setCid(e.target.value)} aria-label={tb("customer")} data-testid="save-basket-customer">
          <option value="">{tb("customer")}</option>
          {customers
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      )}
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tb("namePh")} aria-label={tb("name")} data-testid="save-basket-name" />
      <div className="flex flex-wrap gap-2">
        {(["suggest1", "suggest2"] as const).map((k) => (
          <button key={k} type="button" className="min-h-12 rounded-full border-2 border-line bg-card px-4 font-semibold" onClick={() => setName(tb(k))}>
            {tb(k)}
          </button>
        ))}
      </div>
      {msg && !msg.ok && (
        <p role="alert" className="font-semibold text-brick">
          {msg.text}
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
        <button type="button" className="btn btn-teal" onClick={save} disabled={busy || !name.trim() || (!sale.customerId && !cid)} data-testid="save-basket-confirm">
          {busy ? t("common.saving") : t("common.save")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
