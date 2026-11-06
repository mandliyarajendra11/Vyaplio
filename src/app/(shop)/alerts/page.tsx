"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState, type CSSProperties } from "react";
import { useShop } from "@/components/AppShell";
import { IconWhatsApp } from "@/components/Icons";
import { PendingUpiSheet } from "@/components/PendingUpiSheet";
import { StockAdjustSheet } from "@/components/StockAdjustSheet";
import { Toast } from "@/components/Toast";
import { fmtDate, fmtTime } from "@/lib/dates";
import type { Locale, Product, Sale } from "@/lib/db";
import { useAlerts, useNow, useSupplierDues } from "@/lib/hooks";
import { dayKey } from "@/lib/dates";
import { dueText } from "@/lib/suppliers";
import { DueBadge } from "@/components/SupplierSheets";
import Link from "next/link";
import { formatINR, formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { adjustStock, settlePendingUpi } from "@/lib/ops";
import { waLink } from "@/lib/whatsapp";

export default function AlertsPage() {
  const shop = useShop();
  const t = useTranslations();
  const ta = useTranslations("alerts");
  const locale = useLocale() as Locale;
  const now = useNow();
  const alerts = useAlerts(shop, now);
  const dues = useSupplierDues(shop.id, now);
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settling, setSettling] = useState<Sale | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  if (!alerts) return null;

  const unit = (u: string) => t(`unit.${u}`);
  const orderText = [
    ta("orderHeader", { shop: shop.name }),
    ...[...alerts.shortage, ...alerts.low].map((p) => ta("orderLine", { name: names(p, locale).primary, qty: formatNum(p.qty), unit: unit(p.unit) })),
  ].join("\n");
  let i = 0;
  const delay = () => ({ "--i": i++ }) as CSSProperties;

  return (
    <div className="space-y-8">
      <h1 className="font-brand text-4xl font-semibold">{ta("title")}</h1>
      {alerts.total === 0 && !dues?.length && <p className="rounded-2xl bg-leaf/15 px-5 py-6 text-xl font-bold text-leaf">{ta("allClear")}</p>}

      {alerts.pendingUpi.length > 0 && (
        <section id="upi" className="scroll-mt-4" data-testid="alerts-upi">
          <h2 className="flex items-center gap-2 text-2xl font-bold text-mustard-ink">
            <span className="h-3 w-3 rounded-full bg-mustard ring-4 ring-mustard/30" /> {t("pay.pendingTitle")}
          </h2>
          <p className="text-ink-soft">{t("pay.pendingHint")}</p>
          <ul className="ruled mt-2">
            {alerts.pendingUpi.map((s) => (
              <li key={s.id} style={delay()} className="alert-in flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="num text-lg font-bold">{t("pay.pendingBadge", { amount: formatINR(s.pending) })}</p>
                  <p className="line-clamp-2 text-sm text-ink-soft">
                    {t("pay.pendingLine", {
                      time: `${fmtDate(s.createdAt, locale, "d MMM")} ${fmtTime(s.createdAt, locale)}`,
                      items: s.items.map((it) => names(it, locale).primary).join(", "),
                    })}
                  </p>
                </div>
                <div className="flex max-w-full flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn shrink-0 bg-leaf px-4 text-paper"
                    onClick={() => settlePendingUpi({ saleId: s.id, to: "upi" }).then(() => setToast(t("pay.settled")), () => setToast(t("common.saveFailed")))}
                  >
                    {t("pay.confirmUpi")}
                  </button>
                  <button type="button" className="btn btn-ghost shrink-0 px-3" onClick={() => setSettling(s)}>
                    {t("sale.cash")} / {t("sale.credit")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!dues?.length && (
        <section id="suppliers" className="scroll-mt-4" data-testid="alerts-suppliers">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <span className="h-3 w-3 rounded-full bg-brick ring-4 ring-brick/25" /> {ta("supTitle")}
          </h2>
          <p className="text-ink-soft">{ta("supHint")}</p>
          <ul className="ruled mt-2">
            {dues.map(({ supplier, status }) => (
              <li key={supplier.id} style={delay()} className="alert-in flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-lg font-bold break-words">
                    {supplier.name} <DueBadge state={status.state} />
                  </p>
                  <p className="num font-semibold">{dueText(t, status, dayKey(now))}</p>
                </div>
                <Link href={`/suppliers?id=${encodeURIComponent(supplier.id)}`} className="btn btn-primary shrink-0 px-4" data-testid="alerts-supplier-open">
                  {ta("supPay")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.shortage.length > 0 && (
        <section id="shortage" className="scroll-mt-4" data-testid="alerts-shortage">
          <h2 className="flex items-center gap-2 text-2xl font-bold text-brick">
            <span className="h-3 w-3 rounded-full bg-brick ring-4 ring-brick/25" /> {ta("shortTitle")}
          </h2>
          <p className="text-ink-soft">{ta("shortHint")}</p>
          <ul className="ruled mt-2">
            {alerts.shortage.map((p) => (
              <li key={p.id} style={delay()} className="alert-in flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold break-words">{names(p, locale).primary}</p>
                  <p className="num font-semibold text-brick">{ta("shortLine", { qty: `${formatNum(p.qty)} ${unit(p.unit)}`, short: `${formatNum(-p.qty)} ${unit(p.unit)}` })}</p>
                </div>
                <button type="button" className="btn btn-primary shrink-0 px-4" onClick={() => setAdjusting(p)}>
                  {ta("fix")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.low.length + alerts.shortage.length > 0 && (
        <section id="low" className="scroll-mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-2xl font-bold">
              <span className="h-3 w-3 rounded-full bg-brick" /> {ta("lowTitle")}
            </h2>
            <div className="flex flex-wrap gap-2">
              <Link href="/order" className="btn btn-wa min-h-[48px] text-base" data-testid="alerts-order-suppliers">
                <IconWhatsApp /> {ta("orderSuppliers")}
              </Link>
              <a href={waLink(orderText)} target="_blank" rel="noreferrer" className="btn btn-ghost min-h-[48px] text-base">
                {ta("orderList")}
              </a>
            </div>
          </div>
          <ul className="ruled mt-2">
            {alerts.low.map((p) => (
              <li key={p.id} style={delay()} className="alert-in flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold break-words">{names(p, locale).primary}</p>
                  <p className="text-ink-soft">
                    {ta("lowLine", { qty: `${formatNum(p.qty)} ${unit(p.unit)}`, at: formatNum(p.lowStockAt) })}
                    {p.supplier && <> · {p.supplier}</>}
                  </p>
                </div>
                <button type="button" className="btn btn-teal shrink-0 px-4" onClick={() => adjustStock(p.id, 1)}>
                  {ta("restock")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.expiring.length > 0 && (
        <section id="expiry" className="scroll-mt-4">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <span className="h-3 w-3 rounded-full bg-mustard" /> {ta("expTitle")}
          </h2>
          <ul className="ruled mt-2">
            {alerts.expiring.map((p) => (
              <li key={p.id} style={delay()} className="alert-in flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold break-words">{names(p, locale).primary}</p>
                  <p className="text-ink-soft">
                    <span className="num">{p.expiryDate && fmtDate(p.expiryDate, locale, "d MMM yyyy")}</span> · {formatNum(p.qty)} {unit(p.unit)}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-extrabold ${p.days < 0 ? "bg-brick text-paper" : "bg-mustard-soft text-ink"}`}>
                  {p.days < 0 ? ta("expired", { days: -p.days }) : ta("expDays", { days: p.days })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.dead.length > 0 && (
        <section id="dead" className="scroll-mt-4">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <span className="h-3 w-3 rounded-full bg-ink-soft" /> {ta("deadTitle")}
          </h2>
          <p className="text-ink-soft">{ta("deadHint")}</p>
          <ul className="ruled mt-2">
            {alerts.dead.map((p) => (
              <li key={p.id} style={delay()} className="alert-in py-3">
                <p className="text-lg font-bold break-words">{names(p, locale).primary}</p>
                <p className="text-ink-soft">{ta("deadLine", { days: p.idle, qty: `${formatNum(p.qty)} ${unit(p.unit)}` })}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {adjusting && <StockAdjustSheet key={adjusting.id} product={adjusting} onClose={() => setAdjusting(null)} onSaved={setToast} />}
      {settling && <PendingUpiSheet key={settling.id} sale={settling} onClose={() => setSettling(null)} onDone={setToast} />}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}
