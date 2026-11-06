"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { CSSProperties } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useShop } from "@/components/AppShell";
import { BackupNudge } from "@/components/BackupNudge";
import { IconBell, IconCash, IconChevron, IconSale, IconStock, IconUdhaar } from "@/components/Icons";
import { Sparkline } from "@/components/Sparkline";
import { Wordmark } from "@/components/Wordmark";
import { dayKey, fmtDate } from "@/lib/dates";
import { FIRST_WEEK_STEPS, loadFirstWeekProgress } from "@/lib/firstWeek";
import type { Locale } from "@/lib/db";
import { useAlerts, useCashDay, useCustomers, useNow, useProducts, useOrderCounts, useSupplierDues, useTodayStats, useWeekTotals } from "@/lib/hooks";
import { formatINR, formatNum } from "@/lib/money";

export default function HomePage() {
  const shop = useShop();
  const t = useTranslations("home");
  const locale = useLocale() as Locale;
  const now = useNow();
  const stats = useTodayStats(shop.id, now);
  const week = useWeekTotals(shop.id, now);
  const alerts = useAlerts(shop, now);
  const products = useProducts(shop.id);
  const customers = useCustomers(shop.id);
  const due = (customers ?? []).reduce((a, c) => a + Math.max(c.balance, 0), 0);
  const tCash = useTranslations("cash");
  const tCommon = useTranslations("common");
  const tf = useTranslations("firstWeek");
  const firstWeek = useLiveQuery(() => loadFirstWeekProgress(shop), [shop]);
  const firstWeekDoneCount = firstWeek ? FIRST_WEEK_STEPS.filter((s) => firstWeek.done[s]).length : 0;
  const galla = useCashDay(shop.id, now ? dayKey(now) : null);
  const dues = useSupplierDues(shop.id, now);
  const orders = useOrderCounts(shop.id, now);
  const overdueSuppliers = (dues ?? []).filter((d) => d.status.overdue > 0).length;

  const pendingAmount = (alerts?.pendingUpi ?? []).reduce((sum, bill) => sum + bill.pending, 0);

  const chips = [
    ...(dues?.length
      ? [{ key: "suppliers", label: overdueSuppliers ? t("chipSuppliersLate") : t("chipSuppliers"), count: dues.length, dot: overdueSuppliers ? "bg-brick ring-2 ring-brick/30" : "bg-mustard" }]
      : []),
    ...(alerts?.shortage.length ? [{ key: "shortage", label: t("chipShort"), count: alerts.shortage.length, dot: "bg-brick ring-2 ring-brick/30" }] : []),
    { key: "low", label: t("chipLow"), count: alerts?.low.length ?? 0, dot: "bg-brick" },
    { key: "expiry", label: t("chipExpiry"), count: alerts?.expiring.length ?? 0, dot: "bg-mustard" },
    { key: "dead", label: t("chipDead"), count: alerts?.dead.length ?? 0, dot: "bg-ink-soft" },
  ].filter((chip) => chip.count > 0);

  const actions = [
    { href: "/sale", label: t("actSale"), sub: t("actSaleSub"), Icon: IconSale },
    { href: "/stock", label: t("actStock"), sub: t("actStockSub", { count: products?.length ?? 0 }), Icon: IconStock },
    { href: "/udhaar", label: t("actUdhaar"), sub: t("actUdhaarSub", { amount: formatINR(due) }), Icon: IconUdhaar },
    { href: "/alerts", label: t("actAlerts"), sub: t("actAlertsSub", { count: alerts?.total ?? 0 }), Icon: IconBell },
  ];
  const [primary, ...rest] = actions;

  return (
    <div className="space-y-8">
      <section>
        <Wordmark size="sm" />
        <p className="mt-2 text-ink-soft">{now ? fmtDate(now, locale, "EEEE, d MMMM") : "\u00a0"}</p>
      </section>

      {!shop.isDemo && firstWeekDoneCount < FIRST_WEEK_STEPS.length && <Link href="/firstweek" className="card flex min-h-[72px] items-center gap-3 border-2 border-teal p-4" data-testid="home-firstweek">
        <span className="min-w-0 flex-1"><span className="block text-xl font-bold">{tf("title")}</span><span className="block text-sm text-ink-soft">{firstWeek ? tf("progress", { done: firstWeekDoneCount, total: FIRST_WEEK_STEPS.length }) : tCommon("loading")}</span></span><IconChevron />
      </Link>}

      <section aria-label={t("dailyActions")} className="space-y-3">
        <Link
          href={primary.href}
          className="group flex min-h-[92px] items-center gap-4 rounded-[1.6rem] bg-mustard px-5 py-4 text-ink shadow-[inset_0_-4px_0_var(--mustard-deep)] active:scale-[0.99]"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-ink text-mustard">
            <primary.Icon width={30} height={30} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[1.9rem] leading-tight font-extrabold">{primary.label}</span>
            </span>
            <span className="block font-semibold">{primary.sub}</span>
          </span>
          <IconChevron width={28} height={28} className="transition-transform group-hover:translate-x-1" />
        </Link>
        <Link
          href="/closeout"
          data-testid="home-galla"
          className={`flex min-h-[56px] items-center gap-3 rounded-2xl border-2 px-4 py-2 font-bold ${galla?.closed ? (galla.late.count > 0 ? "border-mustard text-mustard-ink" : "border-leaf/50 text-leaf") : "border-ink/70"}`}
        >
          <IconCash />
          <span className="num min-w-0 flex-1 break-words">
            {!galla ? tCommon("loading") : galla.closed ? tCash("homeClosed", { amount: formatINR(galla.close?.amount ?? 0) }) : tCash("homeLink", { amount: formatINR(galla?.expected ?? 0) })}
            {galla && <span className="mt-1 block text-sm font-semibold">
              {galla.closed ? t(galla.late.count > 0 ? "gallaChanged" : "gallaReview") : t("gallaCount")}
            </span>}
          </span>
          <IconChevron />
        </Link>
        {pendingAmount > 0 && (
          <Link href="/alerts#upi" className="flex min-h-[64px] items-center gap-3 rounded-2xl border-2 border-mustard bg-mustard-soft px-4 py-3 text-ink" data-testid="home-upi-pending">
            <IconBell />
            <span className="min-w-0 flex-1 break-words">
              <span className="num block font-bold">{t("upiPending", { amount: formatINR(pendingAmount) })}</span>
              <span className="block text-sm">{t("checkPending", { count: alerts?.pendingUpi.length ?? 0 })}</span>
            </span>
            <IconChevron />
          </Link>
        )}
      </section>

      {/* Today's money */}
      <section aria-labelledby="today-h">
        <h1 id="today-h" className="eyebrow">
          {t("today")}
        </h1>
        <p className="money-xl mt-2 text-ink">
          <span className="mr-1 align-[0.32em] text-[0.48em] text-mustard-ink">₹</span>
          {stats ? formatNum(stats.total) : "—"}
        </p>
        <p className="mt-2 text-lg text-ink-soft">
          {stats ? t("bills", { count: stats.count }) : tCommon("loading")}
          {!!stats?.returns && <span className="font-semibold text-brick"> · {t("returns", { amount: formatINR(stats.returns) })}</span>}
        </p>
        {/* Honest margin: only sales with a known buy price; a marker when some are missing. */}
        <Link href="/hisaab" className="mt-1 inline-flex min-h-12 flex-wrap items-center gap-x-2 font-semibold text-teal underline-offset-4 hover:underline" data-testid="home-profit" data-coverage={stats?.costCoverage ?? 100}>
          <span className="num">{t("profitLink", { amount: formatINR(stats?.profit ?? 0) })}</span>
          {!!stats && stats.costCoverage < 100 && (
            <span className="num rounded-full bg-mustard-soft px-2 text-sm font-bold text-mustard-ink" data-testid="home-profit-warn">
              {t("profitPartial", { pct: stats.costCoverage })}
            </span>
          )}
          <IconChevron width={18} height={18} />
        </Link>

        <dl className="mt-4 flex flex-wrap gap-y-2 border-y-2 border-ink/80 py-3">
          {(
            [
              ["cash", stats?.cash],
              ["upi", stats?.upi],
              ["credit", stats?.credit],
            ] as const
          ).map(([k, v], i) => (
            <div key={k} className={`min-w-[6.5rem] flex-auto ${i ? "border-l border-dashed border-line pl-3" : ""}`}>
              <dt className="text-sm font-semibold text-ink-soft">{t(k)}</dt>
              <dd className={`num text-xl font-bold [overflow-wrap:anywhere] ${k === "credit" ? "text-brick" : ""}`}>{formatINR(v ?? 0)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <p className="text-ink-soft">{t("received", { amount: formatINR(stats?.received ?? 0) })}</p>
          <div className="text-right">
            <Sparkline values={week ?? [0, 0, 0, 0, 0, 0, 0]} className="h-11 w-40" />
            <p className="text-xs font-semibold text-ink-soft">{t("week")}</p>
          </div>
        </div>
      </section>

      {!!orders?.pending && (
        <Link href="/orders" className="-mt-5 flex min-h-12 flex-wrap items-center gap-x-2 font-semibold text-teal-deep underline-offset-4 hover:underline" data-testid="home-orders" data-pending={orders.pending}>
          <span aria-hidden>📦</span>
          <span className="num">{t("ordersLine", { count: orders.pending, today: orders.today })}</span>
          {orders.ready > 0 && <span className="num rounded-full bg-teal px-2 text-sm font-bold text-paper">{t("ordersReady", { count: orders.ready })}</span>}
          <IconChevron width={18} height={18} />
        </Link>
      )}

      <BackupNudge shop={shop} now={now} />

      {/* Only show stock and supplier alerts that need attention. */}
      {chips.length > 0 && <section aria-label={t("actAlerts")} className="flex flex-wrap gap-2">
        {chips.map((c, i) => (
          <Link
            key={c.key}
            href={`/alerts#${c.key}`}
            style={{ "--i": i } as CSSProperties}
            className="alert-in inline-flex min-h-[48px] max-w-full items-center gap-2 rounded-full border-2 border-line bg-card px-4 font-bold hover:border-teal"
          >
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.dot}`} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{c.label}</span>
            <span className={`num rounded-full px-2 text-sm ${c.count ? "bg-ink text-paper" : "bg-paper-2 text-ink-soft"}`}>{c.count}</span>
          </Link>
        ))}
      </section>}

      {/* Other shop tasks */}
      <nav aria-label={t("otherActions")}>
        <ul className="ruled mt-3">
          {rest.map(({ href, label, sub, Icon }) => (
            <li key={href}>
              <Link href={href} className="group flex min-h-[80px] items-center gap-4 px-1 py-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-teal text-paper">
                  <Icon width={26} height={26} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-2xl leading-tight font-bold">{label}</span>
                  </span>
                  <span className="line-clamp-2 block text-ink-soft">{sub}</span>
                </span>
                <IconChevron className="text-ink-soft transition-transform group-hover:translate-x-1" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Link href="/sales" className="btn btn-ghost w-full">
        {t("viewBills")}
      </Link>
    </div>
  );
}
