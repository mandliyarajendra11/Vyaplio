"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconChevron } from "@/components/Icons";
import { db, type Locale, type Product } from "@/lib/db";
import { FIRST_WEEK_STEPS, loadFirstWeekProgress, markFirstWeekStep, skipFirstWeekStep, type FirstWeekStep } from "@/lib/firstWeek";
import { formatINR, formatNum, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { isLoose } from "@/lib/units";

const href: Partial<Record<FirstWeekStep, string>> = { products: "/stock", backup: "/more#backup", close: "/closeout" };

export default function FirstWeekPage() {
  const shop = useShop();
  const t = useTranslations();
  const tf = useTranslations("firstWeek");
  const locale = useLocale() as Locale;
  const progress = useLiveQuery(() => loadFirstWeekProgress(shop), [shop]);
  const products = useLiveQuery(() => db.products.where("shopId").equals(shop.id).toArray(), [shop.id]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [practicePayment, setPracticePayment] = useState<"cash" | "upi" | "credit">("cash");
  const [busy, setBusy] = useState<FirstWeekStep | null>(null);
  const [error, setError] = useState("");
  const doneCount = progress ? FIRST_WEEK_STEPS.filter((s) => progress.done[s]).length : 0;
  const list = (products ?? []).filter((p) => p.sellPrice > 0 && names(p, locale).primary.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 6);
  const practice = selected && products?.find((p) => p.id === selected.id && p.sellPrice > 0);
  const practiceQty = practice ? isLoose(practice.unit) ? 0.25 : 1 : 0;
  const update = async (step: FirstWeekStep, action: "skip" | "return" | "done") => {
    setBusy(step); setError("");
    try {
      if (action === "done" && (step === "practice" || step === "stock")) await markFirstWeekStep(shop.id, step);
      else await skipFirstWeekStep(shop.id, step, action === "skip");
    } catch { setError(tf("saveFailed")); }
    finally { setBusy(null); }
  };
  return <div className="space-y-5 pb-6">
    <header><h1 className="font-brand text-4xl font-semibold">{tf("title")}</h1><p className="mt-2 text-lg text-ink-soft">{tf("intro")}</p></header>
    <p role="status" className="rounded-2xl bg-teal/10 p-4 text-lg font-bold text-teal-deep">{progress ? tf("progress", { done: doneCount, total: FIRST_WEEK_STEPS.length }) : t("common.loading")}</p>
    {progress && doneCount === FIRST_WEEK_STEPS.length && <p className="rounded-2xl bg-leaf/10 p-4 font-bold text-leaf">{tf("allDone")}</p>}
    {progress && <ol className="space-y-3">
      {FIRST_WEEK_STEPS.map((step, index) => {
        const done = progress.done[step];
        const skipped = progress.state.skipped.includes(step) && !done;
        return <li key={step} className="card space-y-3 p-4" data-testid={`firstweek-${step}`}>
          <div className="flex items-start gap-3"><span className={`num flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-extrabold ${done ? "bg-leaf text-paper" : "bg-teal text-paper"}`}>{done ? "✓" : index + 1}</span><div className="min-w-0 flex-1"><h2 className="text-xl font-bold">{tf(`${step}Title`)}</h2><p className="text-ink-soft">{tf(`${step}Hint`)}</p></div></div>
          <p className={`text-sm font-bold ${done ? "text-leaf" : skipped ? "text-mustard-ink" : "text-ink-soft"}`}>{done ? tf("done") : skipped ? tf("skipped") : tf("todo")}</p>
          {!done && step === "practice" && !skipped && <div className="space-y-3 rounded-2xl bg-paper-2 p-3">
            <p className="font-semibold">{tf("practiceIntro")}</p>
            <label className="block"><span className="label">{tf("findItem")}</span><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tf("searchPlaceholder")} /></label>
            {list.length ? <div className="grid gap-2">{list.map((p) => <button key={p.id} type="button" className={`min-h-12 rounded-xl border-2 px-3 text-left font-semibold ${practice?.id === p.id ? "border-teal bg-teal/10" : "border-line bg-card"}`} onClick={() => setSelected(p)}>{names(p, locale).primary} · {formatINR(p.sellPrice)}/{t(`unit.${p.unit}`)}</button>)}</div> : <p>{tf("noItem")}</p>}
            {practice && <div className="rounded-xl border-2 border-teal bg-card p-3"><p className="font-bold">{tf("practiceBill")}</p><p className="num mt-1">{names(practice, locale).primary} × {formatNum(practiceQty)} {t(`unit.${practice.unit}`)}</p><p className="num mt-1 text-xl font-extrabold">{tf("practiceTotal", { amount: formatINR(round2(practiceQty * practice.sellPrice)) })}</p><p className="mt-3 font-semibold">{tf("practicePay")}</p><div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label={tf("practicePay")}>{(["cash", "upi", "credit"] as const).map((method) => <button key={method} type="button" role="radio" aria-checked={practicePayment === method} className={`min-h-12 rounded-xl border-2 px-1 font-bold ${practicePayment === method ? "border-teal bg-teal text-paper" : "border-line bg-card"}`} onClick={() => setPracticePayment(method)}>{t(`sale.${method}`)}</button>)}</div><p className="mt-2 text-sm font-bold text-teal-deep">{tf("practiceSafe")}</p><button type="button" className="btn btn-primary mt-3 w-full" disabled={busy !== null} onClick={() => void update("practice", "done")}>{tf("practiceDone")}</button></div>}
          </div>}
          {!done && step === "stock" && !skipped && <button type="button" className="btn btn-teal w-full" disabled={busy !== null || !products?.length} onClick={() => void update("stock", "done")}>{tf("stockDone")}</button>}
          {href[step] && <Link href={href[step]} className="btn btn-ghost w-full">{tf(`${step}Action`)} <IconChevron /></Link>}
          {!done && (skipped ? <button type="button" className="min-h-12 w-full font-bold text-teal underline" disabled={busy !== null} onClick={() => void update(step, "return")}>{tf("return")}</button> : <button type="button" className="min-h-12 w-full font-semibold text-ink-soft underline" disabled={busy !== null} onClick={() => void update(step, "skip")}>{tf("skip")}</button>)}
        </li>;
      })}
    </ol>}
    {error && <p role="alert" className="rounded-xl bg-brick/10 p-3 font-semibold text-brick">{error}</p>}
    <Link href="/" className="btn btn-ghost w-full">{tf("home")}</Link>
  </div>;
}
