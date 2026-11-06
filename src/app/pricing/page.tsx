"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { LangToggle } from "@/components/LangToggle";
import { Wordmark } from "@/components/Wordmark";
import type { Locale } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { DEFAULT_SALES_WHATSAPP, PLANS, planEnquiry, salesWhatsAppNumber } from "@/lib/pricing";
import { waLink } from "@/lib/whatsapp";

const seller = salesWhatsAppNumber(process.env.NEXT_PUBLIC_SALES_WHATSAPP || DEFAULT_SALES_WHATSAPP);

export default function PricingPage() {
  const t = useTranslations("pricing");
  const locale = useLocale() as Locale;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: "yearly" | "lifetime") => {
    try { await navigator.clipboard.writeText(planEnquiry(id, locale)); setCopied(id); }
    catch { setCopied("failed"); }
  };
  return <main className="page-enter mx-auto min-h-dvh max-w-[960px] space-y-7 px-5 py-7 lg:px-10 lg:py-10">
    <div className="flex flex-wrap items-center justify-between gap-4"><Wordmark size="sm" /><LangToggle /></div>
    <header className="space-y-2"><h1 className="font-brand text-[clamp(2rem,8vw,3.5rem)] leading-tight font-semibold">{t("title")}</h1><p className="max-w-[46ch] text-lg text-ink-soft">{t("intro")}</p>{seller && <p className="text-base font-semibold">{t("contact")} <a className="text-teal underline underline-offset-4" href={`tel:+${seller}`}>+{seller}</a></p>}</header>
    <div className="grid gap-4 md:grid-cols-2">
      {PLANS.map((plan) => <section key={plan.id} className={`card flex flex-col space-y-4 border-2 p-5 ${plan.id === "yearly" ? "border-teal" : "border-mustard-deep"}`} data-testid={`pricing-${plan.id}`}>
        <div><h2 className="text-2xl font-extrabold">{t(`${plan.id}.name`)}</h2><p className="mt-1 text-ink-soft">{t(`${plan.id}.sub`)}</p></div>
        <p className="num font-brand text-[clamp(2.4rem,10vw,3.4rem)] leading-none font-bold">{formatINR(plan.rupees)}<span className="ml-2 font-sans text-base font-semibold text-ink-soft">{t(`${plan.id}.period`)}</span></p>
        <p className="font-semibold">{t(`${plan.id}.term`)}</p>
        {seller ? <a className="btn btn-primary mt-auto w-full text-lg" href={waLink(planEnquiry(plan.id, locale), seller)} target="_blank" rel="noreferrer">{t("ask")}</a> : <button type="button" className="btn btn-teal mt-auto w-full text-lg" onClick={() => void copy(plan.id)}>{t("copy")}</button>}
        {copied === plan.id && <p role="status" className="text-sm font-semibold text-leaf">{t("copied")}</p>}
        {copied === "failed" && <p role="alert" className="text-sm font-semibold text-brick">{t("copyFailed")}</p>}
      </section>)}
    </div>
    <section className="card space-y-3 p-5"><h2 className="text-xl font-bold">{t("included")}</h2><ul className="ruled">{(["sales", "stock", "udhaar", "daily", "offline", "backup"] as const).map((key) => <li key={key} className="py-2 font-semibold">✓ {t(`feature.${key}`)}</li>)}</ul></section>
    <div className="space-y-2 text-sm text-ink-soft"><p>{t("oneShop")}</p><p>{t("lifetimeScope")}</p><p>{t("noCheckout")}</p></div>
    <Link href="/login" className="btn btn-ghost w-full md:w-auto">{t("backToLogin")}</Link>
  </main>;
}
