"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useDeferredValue, useEffect, useState } from "react";
import { useShop } from "@/components/AppShell";
import { BillSheet, StatusBadge } from "@/components/BillSheet";
import { IconChevron, IconDownload, IconSearch, IconWhatsApp } from "@/components/Icons";
import { PaymentBadges } from "@/components/PaymentBadges";
import {
  BILL_METHODS,
  BILL_STATUSES,
  billNo,
  defaultFilter,
  filterFromParams,
  filterToParams,
  isFiltered,
  PAGE_SIZE,
  PRESETS,
  presetOf,
  presetRange,
  queryBills,
  salesCSVRows,
  SESSION_KEY,
  type BillFilter,
  type BillsResult,
} from "@/lib/bills";
import { downloadCSV, toCSV } from "@/lib/csv";
import { dayKey, fmtDate, fmtTime } from "@/lib/dates";
import type { Locale, Shop } from "@/lib/db";
import { useLiveQuery } from "dexie-react-hooks";
import { useNow } from "@/lib/hooks";
import { formatINR, formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { netTotal, saleStatus } from "@/lib/ops";
import { SALES_CSV_HEADERS } from "@/lib/payments";
import { billText } from "@/lib/share";
import { waLink } from "@/lib/whatsapp";

type T = ReturnType<typeof useTranslations>;

/** Where the filter comes from on first paint: the URL (deep link), else this tab's last filter, else today. */
function initialFilter(now: number, search: string): BillFilter {
  try {
    return filterFromParams(search, now) ?? filterFromParams(window.sessionStorage.getItem(SESSION_KEY) ?? "", now) ?? defaultFilter(now);
  } catch {
    return defaultFilter(now);
  }
}

/** Presets follow the clock (so "yesterday" stays yesterday after midnight); custom ranges are fixed. */
const effective = (f: BillFilter, now: number): BillFilter => (f.preset === "custom" ? f : { ...f, ...presetRange(f.preset, now) });

function rangeLabel(t: T, f: BillFilter, locale: Locale) {
  if (f.preset === "all") return t("bills.rangeAll");
  if (f.from === f.to) return t("bills.rangeOne", { date: fmtDate(f.from, locale, "d MMM yyyy") });
  return t("bills.rangeMany", { from: fmtDate(f.from, locale, "d MMM"), to: fmtDate(f.to, locale, "d MMM yyyy") });
}

export default function SalesPage() {
  // useSearchParams needs a Suspense boundary so the page can still be prerendered (and cached offline).
  return (
    <Suspense fallback={<Loading />}>
      <SalesInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function SalesInner() {
  const shop = useShop();
  const t = useTranslations();
  const tb = useTranslations("bills");
  const locale = useLocale() as Locale;
  const now = useNow();
  const search = useSearchParams().toString(); // read via the router: right on client-side navigation too
  const [raw, setRaw] = useState<BillFilter | null>(null);
  if (!raw && now) setRaw(initialFilter(now, search)); // first client render after mount (now = 0 while prerendering)
  const filter = raw && now ? effective(raw, now) : null;
  const key = filter ? `${filterToParams(filter)}|${filter.from}|${filter.to}` : "";
  const deferred = useDeferredValue(filter);
  const deferredKey = deferred ? `${filterToParams(deferred)}|${deferred.from}|${deferred.to}` : "";
  const result = useLiveQuery(async () => (deferred ? queryBills(shop.id, deferred) : null), [shop.id, deferredKey]);
  const [page, setPage] = useState({ key: "", limit: PAGE_SIZE });
  const limit = page.key === key ? page.limit : PAGE_SIZE;
  const [openId, setOpenId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // Mirror the filter into the address bar (deep link) and this tab's session (no state set here).
  useEffect(() => {
    if (!raw) return;
    const qs = filterToParams(raw);
    try {
      window.sessionStorage.setItem(SESSION_KEY, qs);
      const url = qs ? `/sales?${qs}` : "/sales";
      if (window.location.pathname + window.location.search !== url) window.history.replaceState(window.history.state, "", url);
    } catch {
      /* private mode: the filter just isn't remembered */
    }
  }, [raw]);

  if (!filter || !raw) return <p role="status">{t("common.loading")}</p>;
  const update = (patch: Partial<BillFilter>) => setRaw({ ...raw, ...patch });
  const setPreset = (p: (typeof PRESETS)[number]) => {
    setPicking(false);
    update({ preset: p, ...presetRange(p, now) });
  };
  const setDates = (from: string, to: string) => {
    const today = dayKey(now);
    let a = from || to;
    let b = to || from;
    if (!a) return;
    if (a > b) [a, b] = [b, a];
    if (b > today) b = today;
    if (a > today) a = today;
    update({ preset: presetOf(a, b, now) === "today" ? "today" : "custom", from: a, to: b });
  };
  const toggle = <K extends "methods" | "statuses">(k: K, v: BillFilter[K][number]) => {
    const list = raw[k] as string[];
    update({ [k]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] } as Partial<BillFilter>);
  };
  const stale = result?.filter && deferredKey !== key;
  const res = result && deferred ? result : null;
  const customerName = (id?: string) => (id ? res?.customers.get(id)?.name : undefined);
  const filterCustomer = filter.customerId ? res?.customers.get(filter.customerId) : undefined;
  const multiDay = filter.from !== filter.to;
  const titleKey = filter.preset === "today" && !isFiltered(filter) ? "titleToday" : "title";

  const exportCSV = () => {
    if (!res) return;
    downloadCSV(`bills-${filter.from}-${filter.to}.csv`, toCSV(SALES_CSV_HEADERS, salesCSVRows(res.bills, customerName)));
  };

  return (
    <div>
      <h1 className="font-brand text-4xl font-semibold">{tb(titleKey)}</h1>

      {/* Search */}
      <label className="relative mt-3 block">
        <span className="sr-only">{tb("searchLabel")}</span>
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-soft" />
        <input
          type="search"
          className="input pl-11"
          placeholder={tb("search")}
          aria-label={tb("searchLabel")}
          data-testid="bill-search"
          value={raw.q}
          onChange={(e) => update({ q: e.target.value.slice(0, 80) })}
        />
      </label>

      {/* Dates */}
      {/* Wraps (no hidden horizontal scroll): "सभी" and "तारीख चुनें" stay reachable at 320–390px. */}
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={tb("dates")}>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={raw.preset === p && !picking}
            onClick={() => setPreset(p)}
            className={`min-h-12 rounded-full border-2 px-4 font-bold ${raw.preset === p && !picking ? "border-ink bg-ink text-paper" : "border-line bg-card"}`}
          >
            {tb(`preset_${p}`)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={raw.preset === "custom" || picking}
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
          className={`min-h-12 rounded-full border-2 px-4 font-bold ${raw.preset === "custom" || picking ? "border-ink bg-ink text-paper" : "border-line bg-card"}`}
        >
          📅 {tb("preset_custom")}
        </button>
      </div>
      {(picking || raw.preset === "custom") && (
        <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
          <label className="block">
            <span className="label">{tb("from")}</span>
            <input type="date" className="input num" data-testid="date-from" max={dayKey(now)} value={filter.from === "2000-01-01" ? "" : filter.from} onChange={(e) => setDates(e.target.value, filter.to)} />
          </label>
          <label className="block">
            <span className="label">{tb("to")}</span>
            <input type="date" className="input num" data-testid="date-to" max={dayKey(now)} value={filter.to} onChange={(e) => setDates(filter.from === "2000-01-01" ? e.target.value : filter.from, e.target.value)} />
          </label>
        </div>
      )}

      {/* Payment + status filters */}
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={tb("payTitle")}>
        {BILL_METHODS.map((m) => (
          <Chip key={m} on={raw.methods.includes(m)} onClick={() => toggle("methods", m)}>
            {tb(`pay_${m}`)}
          </Chip>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={tb("statusTitle")}>
        {BILL_STATUSES.map((s) => (
          <Chip key={s} on={raw.statuses.includes(s)} onClick={() => toggle("statuses", s)}>
            {tb(`status_${s}`)}
          </Chip>
        ))}
      </div>
      {filter.customerId && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-teal/10 px-4 py-2" data-testid="customer-filter">
          <Link href={`/udhaar?customer=${filter.customerId}`} className="font-bold text-teal-deep underline">
            {tb("customerFilter", { name: filterCustomer?.name ?? tb("customerUnknown") })}
          </Link>
          <button type="button" className="icon-btn" aria-label={tb("removeCustomer")} onClick={() => update({ customerId: undefined })}>
            ✕
          </button>
        </div>
      )}
      {isFiltered(raw) && (
        <button type="button" className="mt-2 min-h-12 font-semibold text-teal underline" onClick={() => update({ methods: [], statuses: [], q: "", customerId: undefined })}>
          {tb("clear")}
        </button>
      )}

      {/* Summary of the selection */}
      <Summary res={res} filter={filter} shop={shop} stale={!!stale} />

      <ul className={`mt-6 space-y-3 ${stale ? "opacity-60" : ""}`} data-testid="bill-list">
        {res?.bills.slice(0, limit).map((s) => (
          <li key={s.id} className={`card p-4 ${saleStatus(s) === "cancelled" ? "bg-paper-2/70" : ""}`} data-testid="bill">
            <button type="button" onClick={() => setOpenId(s.id)} className="block w-full text-left" aria-label={t("correction.open")}>
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="num font-semibold text-ink-soft">
                  {multiDay ? fmtDate(s.createdAt, locale, "d MMM, h:mm a") : fmtTime(s.createdAt, locale)} · #{billNo(s)}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {res.lateIds.has(s.id) && <span className="rounded-full bg-brick px-2 text-xs font-bold text-paper">{tb("lateBadge")}</span>}
                  <StatusBadge sale={s} />
                  <PaymentBadges sale={s} customerName={customerName(s.customerId)} />
                </span>
              </span>
              <span className={`mt-1 block text-lg ${saleStatus(s) === "cancelled" ? "line-through" : ""}`}>
                {s.items.map((i) => `${names(i, locale).primary} × ${formatNum(i.qty)}`).join(", ")}
              </span>
            </button>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <button type="button" onClick={() => setOpenId(s.id)} className="flex min-h-[48px] items-baseline gap-2 text-left">
                <span className="num font-brand text-2xl font-bold">{formatINR(netTotal(s))}</span>
                {(s.returnedTotal ?? 0) > 0 && <span className="num text-ink-soft line-through">{formatINR(s.total)}</span>}
                <IconChevron width={18} height={18} className="self-center text-ink-soft" />
              </button>
              <a
                href={waLink(billText(t, s, shop, locale), s.customerId ? res.customers.get(s.customerId)?.phone : undefined)}
                target="_blank"
                rel="noreferrer"
                className="icon-btn gap-1 px-3 font-semibold text-wa"
              >
                <IconWhatsApp /> {t("sales.share")}
              </a>
            </div>
          </li>
        ))}
        {res && res.bills.length === 0 && <li className="py-10 text-center text-lg text-ink-soft">{isFiltered(filter) ? tb("noneFiltered") : filter.preset === "today" ? t("sales.none") : tb("none")}</li>}
      </ul>
      {res && res.bills.length > limit && (
        <button type="button" className="btn btn-ghost mt-4 w-full" data-testid="load-more" onClick={() => setPage({ key, limit: limit + PAGE_SIZE })}>
          {tb("loadMore", { count: res.bills.length - limit })}
        </button>
      )}
      {res && res.bills.length > 0 && (
        <p className="num mt-2 text-center text-sm text-ink-soft">{tb("showing", { shown: Math.min(limit, res.bills.length), total: res.bills.length })}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost" onClick={exportCSV} disabled={!res} data-testid="bills-csv">
          <IconDownload /> {tb("csv")}
        </button>
      </div>
      {openId && <BillSheet saleId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-12 min-w-12 rounded-full border-2 px-3 text-sm font-bold ${on ? "border-teal bg-teal text-paper" : "border-line bg-card text-ink-soft"}`}
    >
      {children}
    </button>
  );
}

function Summary({ res, filter, shop, stale }: { res: BillsResult | null; filter: BillFilter; shop: Shop; stale: boolean }) {
  const t = useTranslations();
  const tb = useTranslations("bills");
  const locale = useLocale() as Locale;
  const s = res?.stats;
  const label = rangeLabel(t, filter, locale);
  const filtered = isFiltered(filter);
  const filterText = [
    ...filter.methods.map((m) => tb(`pay_${m}`)),
    ...filter.statuses.map((x) => tb(`status_${x}`)),
    ...(filter.q.trim() ? [`“${filter.q.trim()}”`] : []),
    ...(filter.customerId ? [res?.customers.get(filter.customerId)?.name ?? tb("customerUnknown")] : []),
  ].join(", ");
  const text = s
    ? [
        tb("waHeader", { shop: shop.name, range: label }),
        ...(filtered ? [tb("waFilter", { filter: filterText })] : []),
        t("sales.dayTotal", { amount: formatINR(s.total), count: s.count }),
        t("sales.dayBreak", { cash: formatINR(s.cash), upi: formatINR(s.upi), credit: formatINR(s.credit) }),
        ...(s.upiPending > 0 ? [t("pay.dayPending", { amount: formatINR(s.upiPending) })] : []),
        ...(s.returns > 0 ? [t("home.returns", { amount: formatINR(s.returns) })] : []),
        s.costCoverage < 100 ? t("sales.dayProfitPartial", { amount: formatINR(s.profit), pct: s.costCoverage }) : t("sales.dayProfitHonest", { amount: formatINR(s.profit) }),
        "— Vyaplio",
      ].join("\n")
    : "";
  return (
    <section className={`mt-4 rounded-2xl bg-paper-2 p-4 ${stale ? "opacity-60" : ""}`} aria-live="polite" data-testid="bills-summary">
      <p className="eyebrow" data-testid="bills-range">{label}</p>
      <p className="num mt-1 font-brand text-[clamp(2rem,11vw,3rem)] [overflow-wrap:anywhere] font-bold" data-testid="bills-total">{formatINR(s?.total ?? 0)}</p>
      <p className="text-sm text-ink-soft">
        {tb("summaryTotal")} · <span className="num" data-testid="bills-count">{tb("count", { count: s?.count ?? 0 })}</span>
        {!!s?.splitCount && <> · {tb("splitCount", { count: s.splitCount })}</>}
      </p>
      <p className="num mt-1" data-testid="bills-split">
        {t("home.cash")} {formatINR(s?.cash ?? 0)} · UPI {formatINR(s?.upi ?? 0)} · {t("home.credit")} {formatINR(s?.credit ?? 0)}
      </p>
      {!!s?.upiPending && (
        <Link href="/alerts#upi" className="inline-flex min-h-12 items-center font-semibold text-mustard-ink underline" data-testid="sales-upi-pending">
          {t("home.upiPending", { amount: formatINR(s.upiPending) })}
        </Link>
      )}
      {!!s?.returns && <p className="num font-semibold text-brick" data-testid="bills-returns">{t("home.returns", { amount: formatINR(s.returns) })}</p>}
      <p className="num text-sm text-ink-soft" data-testid="bills-profit">
        {tb("profitHonest", { amount: formatINR(s?.profit ?? 0) })}
        {!filtered && !!s?.received && <> · {tb("received", { amount: formatINR(s.received) })}</>}
      </p>
      {!!s && s.costCoverage < 100 && (
        <p className="num text-sm font-semibold text-mustard-ink" data-testid="bills-profit-warn">
          {tb("profitPartial", { pct: s.costCoverage })}
        </p>
      )}
      {!filtered && (
        <Link
          href={filter.preset === "custom" || filter.preset === "yesterday" || filter.preset === "all" ? `/hisaab?from=${filter.from}&to=${filter.to}` : filter.preset === "today" ? "/hisaab" : `/hisaab?range=${filter.preset}`}
          className="inline-flex min-h-12 items-center text-sm font-semibold text-teal underline"
          data-testid="bills-report-link"
        >
          {tb("openReport")} →
        </Link>
      )}
      {filtered && <p className="mt-1 text-xs text-ink-soft">{tb("filteredNote")}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={waLink(text)} target="_blank" rel="noreferrer" className="btn btn-wa" data-testid="bills-wa">
          <IconWhatsApp /> {filter.preset === "today" && !filtered ? t("sales.shareDay") : tb("shareRange")}
        </a>
        <Link href="/sale" className="btn btn-primary">
          {t("sales.newSale")} →
        </Link>
      </div>
    </section>
  );
}
