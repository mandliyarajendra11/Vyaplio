"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useShop } from "./AppShell";
import { IconWhatsApp } from "./Icons";
import { SaveBasket } from "./OrderBits";
import { PaymentBadges } from "./PaymentBadges";
import { PendingUpiSheet } from "./PendingUpiSheet";
import { Sheet } from "./Sheet";
import { ReceiptPrint } from "./ReceiptPrint";
import { useActor } from "@/lib/actor";
import { fmtDate, fmtTime } from "@/lib/dates";
import type { Locale, RefundBucket, RefundMethod, Sale, SaleCorrection } from "@/lib/db";
import { useCustomers, useSaleWithCorrections } from "@/lib/hooks";
import { formatINR, formatNum, round2, parseMoney } from "@/lib/money";
import { names } from "@/lib/names";
import { billNo } from "@/lib/billno";
import { billDiscountTotal, itemDiscountTotal, roundOffTotal, totalDiscount } from "@/lib/discounts";
import { fmtQty, lineTotal, partValue, isLoose, LOOSE_PRESETS, validQtyFor } from "@/lib/units";
import { CorrectionError, correctSale, netTotal, refundMethodsFor, remainingQty, saleStatus } from "@/lib/ops";
import { crossAmount, paymentsOf, pendingUpi, planRefund, refundCaps, refundsOf } from "@/lib/payments";
import { billText } from "@/lib/share";
import { waLink } from "@/lib/whatsapp";

export const STATUS_STYLE = {
  active: "bg-leaf/15 text-leaf",
  partially_returned: "bg-mustard-soft text-ink",
  cancelled: "bg-brick text-paper",
} as const;

export function StatusBadge({ sale }: { sale: Sale }) {
  const tc = useTranslations("correction");
  const st = saleStatus(sale);
  if (st === "active") return null;
  return (
    <span className={`rounded-full px-3 py-0.5 text-sm font-extrabold ${STATUS_STYLE[st]}`}>
      {st === "cancelled" ? tc("statusCancelled") : tc("statusPartial")}
    </span>
  );
}

type Mode = { kind: "view" } | { kind: "return" | "cancel"; step: "form" | "confirm" };

const REFUND_KEY: Record<RefundBucket, "refundCash" | "refundUpi" | "refundCredit" | "refundPending"> = {
  cash: "refundCash",
  upi: "refundUpi",
  credit: "refundCredit",
  upiPending: "refundPending",
};

/** Bill detail: lines, returns, correction history, return / cancel flow. */
export function BillSheet({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const data = useSaleWithCorrections(saleId);
  if (!data) return null;
  return <BillSheetInner key={data.sale.id} sale={data.sale} corrections={data.corrections} onClose={onClose} />;
}

function BillSheetInner({ sale, corrections, onClose }: { sale: Sale; corrections: SaleCorrection[]; onClose: () => void }) {
  const shop = useShop();
  const actor = useActor(shop);
  const t = useTranslations();
  const tc = useTranslations("correction");
  const locale = useLocale() as Locale;
  const customers = useCustomers(shop.id);
  const customer = customers?.find((c) => c.id === sale.customerId);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const methods = refundMethodsFor(sale, corrections);
  const [refund, setRefund] = useState<RefundMethod>(methods[0] ?? "cash");
  const [cross, setCross] = useState(false);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const status = saleStatus(sale);
  const open = status !== "cancelled";
  const isCancel = mode.kind === "cancel";
  const chosen = sale.items
    .map((it, index) => ({ it, index, qty: isCancel ? remainingQty(it) : (parseMoney(qtys[index] ?? "") ?? 0) }))
    .filter((l) => l.qty > 0);
  const amount = isCancel ? netTotal(sale) : round2(chosen.reduce((a, l) => a + partValue(l.it, l.qty, l.it.returnedQty ?? 0), 0));
  const stockCount = chosen.length;

  const start = (kind: "return" | "cancel") => {
    setMode({ kind, step: "form" });
    setQtys({});
    setReason("");
    setRefund(methods[0] ?? "cash");
    setCross(false);
    setError(null);
    setDone(null);
  };

  const next = () => {
    if (!isCancel && sale.items.some((it, i) => {
      const qty = parseMoney(qtys[i] ?? "");
      return qty === null || !validQtyFor(qty, it.unit, true) || qty > remainingQty(it);
    })) return setError(tc("errQty"));
    if (!reason.trim()) return setError(tc("errReason"));
    if (!chosen.length) return setError(tc("errEmpty"));
    if (needCross && !cross) return setError(tc("errCross"));
    setError(null);
    setMode({ kind: isCancel ? "cancel" : "return", step: "confirm" });
  };

  const submit = async () => {
    if (busy || mode.kind === "view") return;
    setBusy(true);
    setError(null);
    try {
      await correctSale({
        saleId: sale.id,
        type: mode.kind,
        lines: mode.kind === "return" ? chosen.map((l) => ({ index: l.index, qty: l.qty })) : undefined,
        reason,
        refundMethod: refund,
        crossMethod: useCross || undefined,
        byUserId: actor.userId,
        byName: actor.name,
      });
      setDone(mode.kind === "cancel" ? tc("doneCancel") : tc("doneReturn"));
      setMode({ kind: "view" });
    } catch (e) {
      const code = e instanceof CorrectionError ? e.code : null;
      setError(
        code === "reason" ? tc("errReason")
        : code === "empty" ? tc("errEmpty")
        : code === "over" ? tc("errOver")
        : code === "cancelled" ? tc("errCancelled")
        : code === "method" ? (needCross ? tc("errCross") : tc("errMethod"))
        : tc("errGeneric"),
      );
      setMode({ kind: mode.kind, step: "form" });
    } finally {
      setBusy(false);
    }
  };

  const unit = (u: string) => t(`unit.${u}`);
  const methodLabel = (m: RefundBucket) => tc(REFUND_KEY[m]);
  // How this refund will actually be split (pending UPI first, then the chosen route, capped per method).
  // Cash/UPI refunds are capped at what that method brought in on this bill; going beyond needs an explicit tick.
  const caps = refundCaps(sale, corrections);
  const extra = mode.kind !== "view" && amount > 0 ? crossAmount(sale, corrections, amount, refund) : 0;
  const offerCross = refund !== "credit" && extra > 0.005;
  const needCross = offerCross && !methods.includes(refund); // method brought in nothing usable: only possible as cross
  const useCross = offerCross && cross;
  const shownMethods: RefundMethod[] = [...methods, ...(["cash", "upi"] as const).filter((m) => !methods.includes(m))];
  const plan = mode.kind !== "view" && amount > 0 && (!needCross || cross) ? planRefund(sale, corrections, amount, refund, useCross) : [];
  const planText = plan.map((r) => `${methodLabel(r.method)} ${formatINR(r.amount)}`).join(" + ");
  const pending = pendingUpi(sale);
  const parts = paymentsOf(sale);

  const footer =
    mode.kind === "view" ? (
      open ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => start("return")}>
            {tc("returnBtn")}
          </button>
          <button type="button" className="btn btn-ghost border-brick/40 text-brick" onClick={() => start("cancel")}>
            {tc("cancelBtn")}
          </button>
        </div>
      ) : undefined
    ) : mode.step === "form" ? (
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => setMode({ kind: "view" })}>
          {tc("back")}
        </button>
        <button type="button" className="btn btn-primary flex-1 text-lg" onClick={next}>
          {tc("next")} · {formatINR(amount)}
        </button>
      </div>
    ) : (
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => setMode({ kind: mode.kind, step: "form" })} disabled={busy}>
          {tc("back")}
        </button>
        <button type="button" className={`btn flex-1 text-lg ${isCancel ? "bg-brick text-paper" : "btn-teal"}`} onClick={submit} disabled={busy}>
          {isCancel ? tc("doCancel") : tc("doReturn")}
        </button>
      </div>
    );

  return (
    <Sheet open onClose={onClose} title={`${tc("billTitle", { time: fmtDate(sale.createdAt, locale, "d MMM, h:mm a") })} · #${billNo(sale)}`} footer={footer}>
      {done && <p role="status" className="mb-3 rounded-xl bg-leaf/15 px-4 py-2 font-bold text-leaf">{done}</p>}
      {error && <p role="alert" className="mb-3 rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}

      {mode.kind === "view" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PaymentBadges sale={sale} customerName={customer?.name} />
            <StatusBadge sale={sale} />
          </div>
          {customer && (
            <Link href={`/udhaar?customer=${customer.id}`} className="mt-2 inline-flex min-h-12 items-center gap-1 font-bold text-teal-deep underline" data-testid="bill-customer">
              {t("bills.openCustomer", { name: customer.name })} →
            </Link>
          )}
          {parts.map((p, i) =>
            p.method === "cash" && p.tendered !== undefined ? (
              <p key={`c${i}`} className="num mt-1 text-sm text-ink-soft">
                {t("bill.change", { tendered: formatINR(p.tendered), change: formatINR(p.change ?? 0) })}
              </p>
            ) : p.method === "upi" && p.ref ? (
              <p key={`u${i}`} className="num mt-1 text-sm text-ink-soft">UPI · {p.ref}</p>
            ) : null,
          )}
          {pending > 0 && (
            <button type="button" className="btn mt-2 w-full bg-mustard text-ink" onClick={() => setSettling(true)} data-testid="bill-settle-upi">
              {t("pay.pendingBadge", { amount: formatINR(pending) })} — {t("pay.confirmUpi")} / {t("sale.cash")} / {t("sale.credit")}
            </button>
          )}
          <ul className="ruled mt-3">
            {sale.items.map((it, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className={`text-lg font-bold break-words ${remainingQty(it) <= 0 ? "text-ink-soft line-through" : ""}`}>{names(it, locale).primary}</p>
                  <p className="num text-sm text-ink-soft">
                    {it.amount !== undefined
                      ? t("units.byAmount", { amount: formatINR(it.amount), qty: fmtQty(t, it.qty, it.unit), price: formatINR(it.price), unit: unit(it.unit) })
                      : <>{formatINR(it.price)} × {formatNum(it.qty)} {unit(it.unit)}</>}
                    {(it.returnedQty ?? 0) > 0 && (
                      <span className="ml-2 font-bold text-brick">{tc("returnedOf", { returned: formatNum(it.returnedQty ?? 0) })}</span>
                    )}
                  </p>
                  {(it.discount ?? 0) > 0 && <p className="num text-sm text-ink-soft">{t("discount.line", { amount: formatINR(it.discount!) })}</p>}
                </div>
                <span className="num font-bold">{formatINR(lineTotal(it))}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t-2 border-ink/80 pt-3">
            {totalDiscount(sale.items) > 0 && <>
              <div className="flex flex-wrap justify-between gap-2"><dt>{t("discount.subtotal")}</dt><dd className="num">{formatINR(sale.total + totalDiscount(sale.items) - roundOffTotal(sale.items))}</dd></div>
              {itemDiscountTotal(sale.items) > 0 && <div className="flex flex-wrap justify-between gap-2"><dt>{t("discount.itemsTotal")}</dt><dd className="num">−{formatINR(itemDiscountTotal(sale.items))}</dd></div>}
              {billDiscountTotal(sale.items) > 0 && <div className="flex flex-wrap justify-between gap-2"><dt>{t("discount.title")}</dt><dd className="num">−{formatINR(billDiscountTotal(sale.items))}</dd></div>}
            </>}
            {roundOffTotal(sale.items) !== 0 && <div className="flex flex-wrap justify-between gap-2"><dt>{t("rounding.line")}</dt><dd className="num">{roundOffTotal(sale.items) > 0 ? "+" : "−"}{formatINR(Math.abs(roundOffTotal(sale.items)))}</dd></div>}
            <div className="flex justify-between">
              <dt className="text-ink-soft">{tc("original")}</dt>
              <dd className={`num font-bold ${(sale.returnedTotal ?? 0) > 0 ? "text-ink-soft line-through" : ""}`}>{formatINR(sale.total)}</dd>
            </div>
            {(sale.returnedTotal ?? 0) > 0 && (
              <div className="flex justify-between text-brick">
                <dt>{tc("returned")}</dt>
                <dd className="num font-bold">−{formatINR(sale.returnedTotal ?? 0)}</dd>
              </div>
            )}
            <div className="flex flex-wrap items-baseline justify-between">
              <dt className="text-lg font-bold">{tc("net")}</dt>
              <dd className="num font-brand text-3xl font-bold">{formatINR(netTotal(sale))}</dd>
            </div>
          </dl>

          {corrections.length > 0 && (
            <section className="mt-5" aria-labelledby="corr-h">
              <h3 id="corr-h" className="eyebrow">{tc("history")}</h3>
              <ol className="mt-2 space-y-2">
                {corrections.map((c) => (
                  <li key={c.id} className="rounded-2xl border-l-4 border-brick bg-card px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-extrabold">{c.type === "cancel" ? tc("histCancel") : tc("histReturn")}</p>
                      <p className="num font-bold text-brick">{tc("histRefund", {
                        amount: `−${formatINR(c.amount)}`,
                        method: refundsOf(c).map((r) => (refundsOf(c).length > 1 ? `${methodLabel(r.method)} ${formatINR(r.amount)}` : methodLabel(r.method))).join(" + "),
                      })}</p>
                    </div>
                    {c.crossMethod && <p className="text-sm font-bold text-brick">⚠️ {tc("histCross")}</p>}
                    <p className="text-sm text-ink-soft">
                      {tc("histBy", { name: c.byName ?? "—", date: `${fmtDate(c.createdAt, locale, "d MMM")} ${fmtTime(c.createdAt, locale)}` })}
                    </p>
                    <p className="mt-1">“{c.reason}”</p>
                    <p className="text-sm text-ink-soft">
                      {c.lines.map((l) => `${names(l, locale).primary} × ${formatNum(l.qty)}`).join(", ")}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <a href={waLink(billText(t, sale, shop, locale), customer?.phone)} target="_blank" rel="noreferrer" className="btn btn-wa mt-5 w-full">
            <IconWhatsApp /> {t("sales.share")}
          </a>
          {saleStatus(sale) !== "cancelled" && <SaveBasket sale={sale} customers={customers ?? []} />}
          <ReceiptPrint sale={sale} shop={shop} customer={customer} corrections={corrections} />
        </>
      )}

      {mode.kind !== "view" && mode.step === "form" && (
        <div className="space-y-5">
          <h3 className="text-xl font-bold">{isCancel ? tc("cancelTitle") : tc("returnTitle")}</h3>
          <ul className="ruled">
            {sale.items.map((it, i) => {
              const left = remainingQty(it);
              if (left <= 0) return null;
              return (
                <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-lg font-bold break-words">{names(it, locale).primary}</p>
                    <p className="num text-sm text-ink-soft">
                      {formatINR(it.price)} · {tc("remaining", { left: `${formatNum(left)} ${unit(it.unit)}` })}
                    </p>
                  </div>
                  {isCancel ? (
                    <span className="num text-xl font-extrabold">{formatNum(left)}</span>
                  ) : (
                    <div className="w-full space-y-2">
                      <label className="label">
                        {tc("returnQty", { unit: unit(it.unit) })}
                        <input className="input num mt-1 text-xl" inputMode={isLoose(it.unit) ? "decimal" : "numeric"}
                          value={qtys[i] ?? ""} placeholder="0"
                          onChange={(e) => setQtys((q) => ({ ...q, [i]: e.target.value }))} />
                      </label>
                      {isLoose(it.unit) && <div className="flex flex-wrap gap-2">
                        {LOOSE_PRESETS.filter((q) => q <= left).map((q) => <button key={q} type="button"
                          className="min-h-12 rounded-xl border-2 border-line bg-card px-3 font-bold"
                          onClick={() => setQtys((v) => ({ ...v, [i]: String(q) }))}>{fmtQty(t, q, it.unit)}</button>)}
                      </div>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div>
            <label className="label" htmlFor="corr-reason">{tc("reason")}</label>
            <div className="mb-2 flex flex-wrap gap-2">
              {(["r1", "r2", "r3", "r4"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setReason(tc(k))}
                  className={`min-h-12 rounded-full border-2 px-3 font-semibold ${reason === tc(k) ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
                >
                  {tc(k)}
                </button>
              ))}
            </div>
            <input id="corr-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tc("reasonPlaceholder")} />
          </div>

          <div>
            <p className="label">{tc("refundHow")}</p>
            {pending > 0 && <p className="mb-2 text-sm font-semibold text-mustard-ink">{t("pay.refundPendingFirst", { amount: formatINR(Math.min(pending, amount || pending)) })}</p>}
            {methods.length === 0 && <p className="text-ink-soft">{t("pay.refundOnlyPending")}</p>}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,5.25rem),1fr))] gap-2" role="radiogroup">
              {shownMethods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={refund === m}
                  onClick={() => {
                    setRefund(m);
                    setCross(false);
                    setError(null);
                  }}
                  className={`min-h-[56px] rounded-2xl border-2 px-2 font-extrabold ${refund === m ? "border-teal bg-teal text-paper" : methods.includes(m) ? "border-line bg-card" : "border-dashed border-line bg-paper-2 text-ink-soft"}`}
                >
                  {methodLabel(m)}
                  {!methods.includes(m) && <span className="block text-xs font-semibold">{tc("notReceived")}</span>}
                </button>
              ))}
            </div>
            {offerCross && (
              <div className={`mt-2 rounded-2xl border-2 px-3 py-2 ${cross ? "border-brick bg-brick/10" : "border-line"}`} data-testid="cross-refund">
                <label className="flex min-h-12 items-center gap-3 font-bold">
                  <input type="checkbox" className="h-6 w-6 accent-brick" checked={cross} onChange={(e) => setCross(e.target.checked)} />
                  {tc("crossToggle", { method: refund === "upi" ? "UPI" : t("sale.cash") })}
                </label>
                {cross && (
                  <p role="alert" className="text-sm font-semibold text-brick">
                    {tc("crossWarn", { method: refund === "upi" ? "UPI" : t("sale.cash"), cap: formatINR(caps[refund]), extra: formatINR(extra) })}
                  </p>
                )}
              </div>
            )}
            {plan.length > 1 && <p className="num mt-2 text-sm font-semibold" data-testid="refund-plan">{t("pay.refundPlan", { parts: planText })}</p>}
          </div>
        </div>
      )}

      {mode.kind !== "view" && mode.step === "confirm" && (
        <div className="space-y-3">
          <h3 className="text-xl font-bold">{tc("confirmTitle")}</h3>
          <p className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] [overflow-wrap:anywhere] font-bold text-brick">{tc("confirmAmount", { amount: formatINR(amount) })}</p>
          <ul className="space-y-1 text-lg">
            <li>• {tc("confirmStock", { count: stockCount })}</li>
            {plan.map((r) => (
              <li key={r.method}>
                •{" "}
                {r.method === "credit"
                  ? tc("confirmUdhaar", { name: customer?.name ?? "", amount: formatINR(r.amount) })
                  : r.method === "upiPending"
                    ? `${tc("refundPending")} ${formatINR(r.amount)}`
                    : tc("confirmRefund", { amount: formatINR(r.amount), method: r.method === "upi" ? "UPI" : t("sale.cash") })}
              </li>
            ))}
            <li className="text-ink-soft">• “{reason.trim()}”</li>
          </ul>
          <p className="rounded-xl bg-paper-2 px-4 py-2 text-ink-soft">{tc("confirmFinal")}</p>
        </div>
      )}
      {settling && <PendingUpiSheet sale={sale} onClose={() => setSettling(false)} onDone={setDone} />}
    </Sheet>
  );
}
