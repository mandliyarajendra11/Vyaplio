"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { createContext, useContext, useEffect } from "react";
import type { Locale, Shop } from "@/lib/db";
import { fmtTime } from "@/lib/dates";
import { useAlerts, useCustomers, useNow, useOfflineStatus, useOnline, useSessionUser, useShopForUser, useTodaySales } from "@/lib/hooks";
import { formatINR } from "@/lib/money";
import { IconBell, IconCash, IconHome, IconMore, IconSale, IconStock, IconUdhaar, IconWifiOff } from "./Icons";
import { useAppLock } from "@/lib/lock";
import { LangToggle } from "./LangToggle";
import { PinLock } from "./PinLock";
import { Splash } from "./Splash";
import { Wordmark } from "./Wordmark";

const ShopContext = createContext<Shop | null>(null);

export function useShop(): Shop {
  const shop = useContext(ShopContext);
  if (!shop) throw new Error("useShop outside AppShell");
  return shop;
}

const NAV = [
  { href: "/", key: "home", Icon: IconHome },
  { href: "/sale", key: "sale", Icon: IconSale },
  { href: "/stock", key: "stock", Icon: IconStock },
  { href: "/udhaar", key: "udhaar", Icon: IconUdhaar },
  { href: "/galla", key: "galla", Icon: IconCash },
  { href: "/alerts", key: "alerts", Icon: IconBell },
] as const;

const MOBILE_NAV = [NAV[0], NAV[1], NAV[3], NAV[4], { href: "/more", key: "more", Icon: IconMore }] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const userId = useSessionUser();
  const shop = useShopForUser(userId);
  const router = useRouter();
  const lock = useAppLock(shop ? userId : null);

  useEffect(() => {
    if (!userId) router.replace("/login");
    else if (shop === null) router.replace("/setup");
  }, [userId, shop, router]);

  if (!userId || !shop || lock === "checking") return <Splash />;
  if (lock === "locked") return <PinLock shop={shop} userId={userId} />;
  return (
    <ShopContext.Provider value={shop}>
      <Frame shop={shop}>{children}</Frame>
    </ShopContext.Provider>
  );
}

function Frame({ shop, children }: { shop: Shop; children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations();
  const online = useOnline();
  const now = useNow();
  const alerts = useAlerts(shop, now);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : (pathname === href || pathname.startsWith(`${href}/`)));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[104px_minmax(0,600px)_340px] lg:justify-center lg:gap-10 lg:px-6">
      {/* Desktop rail */}
      <nav className="sticky top-0 hidden h-dvh flex-col items-center gap-2 py-8 lg:flex" aria-label="main">
        <Link href="/" className="mb-6 inline-flex min-h-12 min-w-12 items-center justify-center font-brand text-3xl font-bold text-teal-deep" aria-label="Vyaplio">
          V<span className="italic text-mustard-strong">y</span>
        </Link>
        {[...NAV, { href: "/more", key: "more", Icon: IconMore } as const].map(({ href, key, Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            className={`relative flex w-full flex-col items-center gap-1 rounded-2xl py-3 text-sm font-semibold ${
              isActive(href) ? "bg-teal text-paper" : "text-ink-soft hover:bg-paper-2"
            }`}
          >
            <Icon />
            {t(`nav.${key}`)}
            {key === "alerts" && !!alerts?.total && (
              <span className="num absolute top-1.5 right-4 rounded-full bg-brick px-1.5 text-xs text-paper">{alerts.total}</span>
            )}
          </Link>
        ))}
      </nav>

      <div className="mx-auto w-full max-w-[600px] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] pt-[max(0.75rem,env(safe-area-inset-top))] pb-[calc(6.5rem+env(safe-area-inset-bottom))] lg:pt-8 lg:pb-12">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-[min(100%,8rem)] flex-1">
            <p className="line-clamp-2 text-lg leading-tight font-bold break-words">{shop.name}</p>
            <p className="truncate text-sm text-ink-soft">{shop.ownerName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!online && (
              <span className="icon-btn bg-brick/10 text-brick" title={t("common.offline")}>
                <IconWifiOff />
              </span>
            )}
            <LangToggle shopId={shop.id} />
            <Link href="/alerts" className="icon-btn relative bg-paper-2 text-teal-deep lg:hidden" aria-label={t("nav.alertCount", { count: alerts?.total ?? 0 })}>
              <IconBell />
              {!!alerts?.total && <span aria-hidden="true" className="num absolute -top-1 -right-1 rounded-full bg-brick px-1.5 text-xs text-paper">{alerts.total}</span>}
            </Link>
          </div>
        </header>
        {!online && <p className="mb-4 rounded-2xl bg-ink px-4 py-3 text-paper">{t("common.offline")}</p>}
        <main key={pathname} className="page-enter">
          {children}
        </main>
      </div>

      <aside className="sticky top-0 hidden h-dvh overflow-y-auto py-8 lg:block">
        <ShopAside shop={shop} now={now} />
      </aside>

      {/* Mobile bottom nav */}
      <nav
        aria-label="main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto grid max-w-[600px] grid-cols-5">
          {MOBILE_NAV.map(({ href, key, Icon }) => {
            const active = key === "more" ? !MOBILE_NAV.slice(0, 4).some((item) => isActive(item.href)) : isActive(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-h-[64px] flex-col items-center justify-center gap-0.5 px-0.5 text-center text-sm leading-tight font-bold [overflow-wrap:anywhere] ${
                    active ? "text-teal-deep" : "text-ink-soft"
                  }`}
                >
                  {active && <span className="absolute top-0 h-1 w-10 max-w-[80%] rounded-b-full bg-mustard" />}
                  <span className={key === "sale" ? "flex h-9 w-9 items-center justify-center rounded-full bg-mustard text-ink" : ""}>
                    <Icon />
                  </span>
                  {t(`nav.${key}`)}

                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function ShopAside({ shop, now }: { shop: Shop; now: number }) {
  const t = useTranslations("aside");
  const tn = useTranslations("nav");
  const locale = useLocale() as Locale;
  const sales = useTodaySales(shop.id, now);
  const customers = useCustomers(shop.id);
  const due = (customers ?? []).reduce((a, c) => a + Math.max(c.balance, 0), 0);
  return (
    <div className="space-y-6">
      <Wordmark size="sm" />
      <div>
        <div className="receipt-edge rotate-180" />
        <div className="bg-card px-5 py-4">
          <p className="eyebrow">{t("recent")}</p>
          {sales && sales.length > 0 ? (
            <ul className="ruled mt-2">
              {sales.slice(0, 7).map((s) => (
                <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-3 py-2">
                  <span className="line-clamp-2 min-w-0 text-ink-soft">
                    <span className="num">{fmtTime(s.createdAt, locale)}</span> ·{" "}
                    {s.items.map((i) => (locale === "hi" ? i.nameHi : i.nameEn)).join(", ")}
                  </span>
                  <span className={`num font-bold ${s.status === "cancelled" ? "text-ink-soft line-through" : ""}`}>{formatINR(s.total - (s.returnedTotal ?? 0))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-ink-soft">{t("none")}</p>
          )}
          <Link href="/sales" className="mt-2 inline-flex min-h-12 items-center font-semibold text-teal underline-offset-4 hover:underline">
            {tn("sales")} →
          </Link>
        </div>
        <div className="receipt-edge" />
      </div>
      <div className="px-1">
        <p className="eyebrow">{t("due")}</p>
        <p className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] [overflow-wrap:anywhere] font-bold text-brick">{formatINR(due)}</p>
      </div>
      <OfflineReadiness className="px-1" />
      <p className="px-1 text-sm text-ink-soft">{t("tip")}</p>
    </div>
  );
}

/** Truthful "works without internet" line, driven by the service worker's cache status. */
export function OfflineReadiness({ className = "" }: { className?: string }) {
  const t = useTranslations("common");
  const { state } = useOfflineStatus();
  const dot = state === "ready" ? "bg-leaf" : state === "preparing" ? "bg-mustard animate-pulse" : "bg-ink-soft";
  return (
    <p className={`text-ink-soft ${className}`} role="status" data-offline-state={state}>
      <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
      {t(state === "ready" ? "offlineReady" : state === "preparing" ? "offlinePreparing" : "offlineUnsupported")}
    </p>
  );
}
