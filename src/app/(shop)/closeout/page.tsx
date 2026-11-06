"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconWhatsApp } from "@/components/Icons";
import { useActor } from "@/lib/actor";
import { closeDay, loadCashDay } from "@/lib/cash";
import { closeoutText } from "@/lib/closeout";
import { dayKey, fmtDate } from "@/lib/dates";
import type { Locale } from "@/lib/db";
import { useAlerts, useCashDay, useNow, useTodayStats } from "@/lib/hooks";
import { formatINR, round2 } from "@/lib/money";
import { parseDecimal } from "@/lib/productImport";
import { waLink } from "@/lib/whatsapp";

export default function CloseoutPage() {
  const shop = useShop();
  const t = useTranslations();
  const tc = useTranslations("closeout");
  const locale = useLocale() as Locale;
  const now = useNow();
  const day = now ? dayKey(now) : null;
  const cash = useCashDay(shop.id, day);
  const stats = useTodayStats(shop.id, now);
  const alerts = useAlerts(shop, now);
  const actor = useActor(shop);
  const [count, setCount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!cash || !stats || !alerts || !day) return <p role="status">{t("common.loading")}</p>;
  const counted = parseDecimal(count);
  const valid = Number.isFinite(counted) && counted <= 1_000_000_000;
  const diff = valid ? round2(counted - cash.expected) : 0;
  const pending = alerts.pendingUpi.reduce((sum, bill) => sum + bill.pending, 0);
  const stockCount = alerts.shortage.length + alerts.low.length + alerts.expiring.length;
  const collected = cash.cashIn.udhaar + cash.upi.udhaar;
  const save = async () => {
    if (!day || !valid || busy || cash.closed) return;
    setBusy(true); setError("");
    try {
      const fresh = await loadCashDay(shop.id, day);
      if (fresh.closed || Math.abs(fresh.expected - cash.expected) > 0.005) { setError(tc("changed")); return; }
      await closeDay({ shopId: shop.id, day, counted, reason: reason.trim() || undefined, byName: actor.name });
      setCount(""); setReason("");
    } catch { setError(tc("failed")); }
    finally { setBusy(false); }
  };
  return <div className="space-y-5 pb-6">
    <header><h1 className="font-brand text-4xl font-semibold">{tc("title")}</h1><p className="mt-1 text-ink-soft">{fmtDate(day, locale, "EEEE, d MMM yyyy")}</p><p className="mt-2 text-lg font-semibold">{cash.closed ? tc("closed") : tc("intro")}</p></header>

    <section className="card space-y-3 p-4" aria-labelledby="closeout-check">
      <h2 id="closeout-check" className="text-xl font-bold">{tc("step1")}</h2>
      <p className="num text-lg">{tc("sales", { amount: formatINR(stats.total), count: stats.count })}</p>
      <p className="num text-lg">{tc("collected", { amount: formatINR(collected) })}</p>
      <div className={`rounded-xl p-3 ${pending > 0 ? "bg-mustard-soft" : "bg-leaf/10"}`}>
        <p className="num font-bold">{pending > 0 ? tc("upiPending", { amount: formatINR(pending), count: alerts.pendingUpi.length }) : tc("upiClear")}</p>
        {pending > 0 && <Link className="mt-2 inline-flex min-h-12 items-center font-bold text-teal underline" href="/alerts#upi">{tc("checkUpi")}</Link>}
      </div>
      <div className={`rounded-xl p-3 ${stockCount > 0 ? "bg-mustard-soft" : "bg-leaf/10"}`}>
        <p className="font-bold">{stockCount > 0 ? tc("stockIssues", { shortage: alerts.shortage.length, low: alerts.low.length, expiring: alerts.expiring.length }) : tc("stockClear")}</p>
        {stockCount > 0 && <Link className="mt-2 inline-flex min-h-12 items-center font-bold text-teal underline" href="/alerts">{tc("checkStock")}</Link>}
      </div>
      <p className="text-sm text-ink-soft">{tc("issuesHint")}</p>
    </section>

    <section className="card space-y-3 p-4" aria-labelledby="closeout-cash">
      <h2 id="closeout-cash" className="text-xl font-bold">{tc("step2")}</h2>
      <p className="num text-lg font-semibold">{tc("expected", { amount: formatINR(cash.expected) })}</p>
      {cash.closed ? <div className="rounded-xl bg-leaf/10 p-3"><p className="num font-bold text-leaf">{tc("counted", { amount: formatINR(cash.close?.amount ?? 0) })}</p><p>{cash.late.count > 0 ? tc("late", { count: cash.late.count }) : tc("done")}</p></div> : <>
        <label className="block"><span className="label">{tc("enterCount")}</span><input className="input num text-2xl" inputMode="decimal" value={count} onChange={(e) => setCount(e.target.value)} placeholder="₹0" autoComplete="off" /></label>
        {valid && <p className={`num rounded-xl p-3 font-bold ${Math.abs(diff) < 0.005 ? "bg-leaf/10 text-leaf" : "bg-mustard-soft text-ink"}`}>{Math.abs(diff) < 0.005 ? tc("matched") : diff < 0 ? tc("short", { amount: formatINR(-diff) }) : tc("over", { amount: formatINR(diff) })}</p>}
        {valid && Math.abs(diff) >= 0.005 && <label className="block"><span className="label">{tc("reason")}</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tc("reasonHint")} /></label>}
        <button type="button" className="btn btn-primary min-h-[60px] w-full text-xl" disabled={!valid || busy} onClick={save}>{busy ? t("common.saving") : tc("close")}</button>
        <p className="text-sm text-ink-soft">{tc("cashHint")}</p>
      </>}
      {error && <p role="alert" className="rounded-xl bg-brick/10 p-3 font-semibold text-brick">{error}</p>}
      <Link href="/galla" className="inline-flex min-h-12 items-center font-bold text-teal underline">{tc("details")}</Link>
    </section>

    <section className="card space-y-3 p-4" aria-labelledby="closeout-share">
      <h2 id="closeout-share" className="text-xl font-bold">{tc("step3")}</h2>
      <p className="text-ink-soft">{tc("shareHint")}</p>
      <a href={waLink(closeoutText(t, cash, shop, locale, stats, alerts))} target="_blank" rel="noreferrer" className="btn btn-wa w-full"><IconWhatsApp /> {tc("share")}</a>
      {!cash.closed && <p className="text-sm text-ink-soft">{tc("openShare")}</p>}
    </section>
  </div>;
}
