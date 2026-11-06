"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconDownload, IconWhatsApp } from "@/components/Icons";
import { Sheet } from "@/components/Sheet";
import { Toast } from "@/components/Toast";
import { downloadCSV, toCSV } from "@/lib/csv";
import { dayKey } from "@/lib/dates";
import { db, EXPENSE_CATEGORIES, type Locale, type Product } from "@/lib/db";
import { useNow } from "@/lib/hooks";
import { formatINR, formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { setBuyPrice } from "@/lib/ops";
import { costChecks, coveragePct, lowMarginItems, topItems, type ItemRow, type ProfitReport } from "@/lib/profit";
import {
  customRange,
  explainLines,
  loadReport,
  rangeFromParams,
  rangeText,
  rangeToParams,
  REPORT_CSV_HEADERS,
  REPORT_PRESETS,
  reportCSVRows,
  reportRange,
  reportText,
  type ReportRange,
} from "@/lib/report";
import { waLink } from "@/lib/whatsapp";

export default function HisaabPage() {
  // useSearchParams (deep link ?range=week / ?from=&to=) needs a Suspense boundary for prerendering.
  return (
    <Suspense fallback={<Loading />}>
      <HisaabInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

/** Presets follow the clock (this week stays this week tomorrow); a custom range is fixed. */
const effective = (r: ReportRange, now: number): ReportRange => (r.preset === "custom" ? r : reportRange(r.preset, now));

function HisaabInner() {
  const shop = useShop();
  const t = useTranslations();
  const tr = useTranslations("report");
  const locale = useLocale() as Locale;
  const now = useNow();
  const search = useSearchParams().toString();
  const [raw, setRaw] = useState<ReportRange | null>(null);
  if (!raw && now) setRaw(rangeFromParams(search, now));
  const range = raw && now ? effective(raw, now) : null;
  const [picking, setPicking] = useState(false);
  const [buyFor, setBuyFor] = useState<{ productId: string; fill: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const report = useLiveQuery(async () => (range ? loadReport(shop.id, range.from, range.to) : null), [shop.id, range?.from, range?.to]);

  useEffect(() => {
    if (!raw) return;
    const qs = rangeToParams(raw);
    const url = qs ? `/hisaab?${qs}` : "/hisaab";
    try {
      if (window.location.pathname + window.location.search !== url) window.history.replaceState(window.history.state, "", url);
    } catch {
      /* ignore */
    }
  }, [raw]);

  if (!range || !raw) return <Loading />;
  const r = report && report.from === range.from && report.to === range.to ? report : null;
  const today = dayKey(now);
  const setDates = (a: string, b: string) => {
    const next = customRange(a, b, now);
    if (next) setRaw(next);
  };
  const exportCSV = () => r && downloadCSV(`hisaab-${range.from}-${range.to}.csv`, toCSV(REPORT_CSV_HEADERS, reportCSVRows(r)));

  return (
    <div className="space-y-5" data-testid="report">
      <header>
        <h1 className="font-brand text-4xl font-semibold">{tr("title")}</h1>
        <p className="text-ink-soft">{tr("sub")}</p>
      </header>

      {/* Range: today / week / month / custom (same day boundaries as the bills screen) */}
      <div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={tr("dates")}>
          {REPORT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={raw.preset === p && !picking}
              data-range={p}
              onClick={() => {
                setPicking(false);
                setRaw(reportRange(p, now));
              }}
              className={`min-h-12 rounded-full border-2 px-4 font-bold ${raw.preset === p && !picking ? "border-ink bg-ink text-paper" : "border-line bg-card"}`}
            >
              {tr(`preset_${p}`)}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={raw.preset === "custom" || picking}
            aria-expanded={picking}
            data-range="custom"
            onClick={() => setPicking((v) => !v)}
            className={`min-h-12 rounded-full border-2 px-4 font-bold ${raw.preset === "custom" || picking ? "border-ink bg-ink text-paper" : "border-line bg-card"}`}
          >
            📅 {tr("preset_custom")}
          </button>
        </div>
        {(picking || raw.preset === "custom") && (
          <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
            <label className="block">
              <span className="label">{tr("from")}</span>
              <input type="date" className="input num" data-testid="report-from" max={today} value={range.from} onChange={(e) => setDates(e.target.value, range.to)} />
            </label>
            <label className="block">
              <span className="label">{tr("to")}</span>
              <input type="date" className="input num" data-testid="report-to" max={today} value={range.to} onChange={(e) => setDates(range.from, e.target.value)} />
            </label>
          </div>
        )}
      </div>

      {!r ? (
        <Loading />
      ) : (
        <>
          <Headline r={r} label={rangeText(t, range, locale)} />
          <Breakdown r={r} />
          {r.missing.length > 0 && <MissingList r={r} onAdd={(productId, fill) => setBuyFor({ productId, fill })} />}
          <MoneySection r={r} />
          <ExpensesSection r={r} />
          <ItemsSection r={r} onCheck={(productId) => setBuyFor({ productId, fill: false })} />

          <section className="card p-4" aria-labelledby="r-explain" data-testid="report-explain">
            <h2 id="r-explain" className="eyebrow">{tr("explainTitle")}</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              {explainLines(t, r).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </section>

          <div className="flex flex-wrap gap-2">
            <a href={waLink(reportText(t, r, shop, range, locale))} target="_blank" rel="noreferrer" className="btn btn-wa" data-testid="report-wa">
              <IconWhatsApp /> {tr("share")}
            </a>
            <button type="button" className="btn btn-ghost" onClick={exportCSV} data-testid="report-csv">
              <IconDownload /> {tr("csv")}
            </button>
          </div>
        </>
      )}

      {buyFor && (
        <BuyPriceSheet
          productId={buyFor.productId}
          offerFill={buyFor.fill}
          onClose={() => setBuyFor(null)}
          onSaved={(filled) => {
            setBuyFor(null);
            setToast(filled > 0 ? tr("savedFilled", { count: filled }) : tr("savedOnly"));
          }}
        />
      )}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

function Headline({ r, label }: { r: ProfitReport; label: string }) {
  const tr = useTranslations("report");
  const pct = coveragePct(r);
  const loss = r.netEarned < 0;
  return (
    <section className="rounded-2xl bg-paper-2 p-4" aria-live="polite" data-testid="report-head">
      <p className="eyebrow" data-testid="report-range">{label}</p>
      <h2 className="mt-1 text-lg font-bold">{tr("netEarnedTitle")}</h2>
      <p className={`num font-brand text-[clamp(2rem,11vw,3rem)] font-bold [overflow-wrap:anywhere] ${loss ? "text-brick" : ""}`} data-testid="report-net">
        {loss ? "−" : ""}
        {formatINR(Math.abs(r.netEarned))}
      </p>
      <p className="text-sm text-ink-soft">{tr("netEarnedSub")}</p>
      <div className="mt-3" data-testid="report-coverage" data-pct={pct}>
        <p className={`font-semibold ${r.complete ? "text-leaf" : "text-mustard-ink"}`}>{r.complete ? tr("coverageFull") : tr("coverage", { pct })}</p>
        <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-card" role="presentation">
          <div className={`h-full rounded-full ${r.complete ? "bg-leaf" : "bg-mustard"}`} style={{ width: `${pct}%` }} />
        </div>
        {!r.complete && (
          <p className="mt-2 rounded-xl bg-mustard-soft px-3 py-2 text-sm font-semibold text-mustard-ink" role="note" data-testid="report-partial">
            {tr("partialWarn")}
          </p>
        )}
      </div>
    </section>
  );
}

function Row({ label, value, strong, minus, testId, sub }: { label: string; value: number; strong?: boolean; minus?: boolean; testId?: string; sub?: string }) {
  return (
    <div className={`flex flex-wrap items-baseline justify-between gap-x-3 py-2 ${strong ? "font-bold" : ""}`}>
      <dt className="min-w-0 flex-1">
        {label}
        {sub && <span className="block text-sm font-normal text-ink-soft">{sub}</span>}
      </dt>
      <dd className="num [overflow-wrap:anywhere]" data-testid={testId}>
        {minus && value > 0 ? "−" : value < 0 ? "−" : ""}
        {formatINR(Math.abs(value))}
      </dd>
    </div>
  );
}

function Breakdown({ r }: { r: ProfitReport }) {
  const tr = useTranslations("report");
  return (
    <section className="card p-4" aria-label={tr("netEarnedSub")} data-testid="report-breakdown">
      <dl className="ruled">
        <Row label={tr("rowSales")} value={r.netSales} testId="r-sales" sub={r.returns > 0 ? tr("rowReturns", { amount: formatINR(r.returns) }) : undefined} />
        {!r.complete && <Row label={tr("rowUnknown")} value={r.unknownSales} minus testId="r-unknown" />}
        <Row label={tr("rowCogs")} value={r.cogs} minus testId="r-cogs" />
        <Row label={tr("rowMargin")} value={r.margin} strong testId="r-margin" />
        <Row label={tr("rowExpenses")} value={r.expenses.total} minus testId="r-expenses" />
        <Row label={tr("rowLosses")} value={r.losses.total} minus testId="r-losses" />
        <Row label={tr("rowNet")} value={r.netEarned} strong testId="r-net" />
      </dl>
    </section>
  );
}

function MissingList({ r, onAdd }: { r: ProfitReport; onAdd: (productId: string, fill: boolean) => void }) {
  const tr = useTranslations("report");
  const t = useTranslations();
  const locale = useLocale() as Locale;
  return (
    <section className="card border-mustard p-4" aria-labelledby="r-missing" data-testid="report-missing">
      <h2 id="r-missing" className="text-xl font-bold">
        ⚠ {tr("missingTitle")}
      </h2>
      <p className="text-ink-soft">{tr("missingHint")}</p>
      <ul className="ruled mt-2">
        {r.missing.map((m) => (
          <li key={m.key} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="missing-item" data-name={m.nameHi}>
            <span className="min-w-0 flex-1">
              <span className="block font-bold">{names(m, locale).primary}</span>
              <span className="num block text-sm text-ink-soft">{tr("missingLine", { qty: `${formatNum(m.qty)} ${t(`unit.${m.unit}`)}`, amount: formatINR(m.sales) })}</span>
            </span>
            {m.exists ? (
              <button type="button" className="btn btn-teal min-h-12 px-4" data-testid="add-buy" onClick={() => onAdd(m.productId, true)}>
                {m.buyPriceNow > 0 ? tr("hasPriceNow", { amount: formatINR(m.buyPriceNow) }) : tr("addBuy")}
              </button>
            ) : (
              <span className="text-sm text-ink-soft">{tr("deleted")}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MoneySection({ r }: { r: ProfitReport }) {
  const tr = useTranslations("report");
  return (
    <section className="card p-4" aria-labelledby="r-money" data-testid="report-money">
      <h2 id="r-money" className="eyebrow">{tr("moneyTitle")}</h2>
      <dl className="ruled mt-1">
        <Row label={tr("collected")} value={r.collected} testId="r-collected" />
        <Row label={tr("onCredit")} value={r.onCredit} testId="r-credit" />
        {r.upiPending > 0 && <Row label={tr("upiPending")} value={r.upiPending} />}
      </dl>
      {r.onCredit > 0 && (
        <p className="mt-2 rounded-xl bg-brick/10 px-3 py-2 text-sm font-semibold text-brick" data-testid="r-credit-note">
          {tr("creditNote", { amount: formatINR(Math.max(0, r.marginOnCredit)) })}
        </p>
      )}
      {r.udhaarReceived > 0 && <p className="mt-2 text-sm text-ink-soft">{tr("received", { amount: formatINR(r.udhaarReceived) })}</p>}
    </section>
  );
}

function ExpensesSection({ r }: { r: ProfitReport }) {
  const tr = useTranslations("report");
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const cats = EXPENSE_CATEGORIES.filter((c) => (r.expenses.byCategory[c] ?? 0) > 0);
  const notExp = r.notExpenses.withdrawal + r.notExpenses.supplier + r.notExpenses.bank + (r.purchases?.total ?? 0) + (r.purchases?.paidUpi ?? 0);
  return (
    <>
      <section className="card p-4" aria-labelledby="r-exp" data-testid="report-expenses">
        <h2 id="r-exp" className="eyebrow">{tr("expensesTitle")}</h2>
        {cats.length ? (
          <dl className="ruled mt-1">
            {cats.map((c) => (
              <Row key={c} label={t(`cash.cat_${c}`)} value={r.expenses.byCategory[c] ?? 0} />
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-ink-soft">
            {tr("noExpenses")} ·{" "}
            <Link href="/galla" className="font-semibold text-teal underline">
              {tr("expensesHint")}
            </Link>
          </p>
        )}
        {r.losses.rows.length > 0 && (
          <>
            <h3 className="eyebrow mt-4">{tr("lossesTitle")}</h3>
            <ul className="ruled mt-1" data-testid="report-losses">
              {r.losses.rows.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    {names(l, locale).primary} · {tr(`loss_${l.reason}`)} · <span className="num">{formatNum(l.qty)} {t(`unit.${l.unit}`)}</span>
                    {l.estimated && <span className="block text-sm text-ink-soft">{tr("lossEstimated")}</span>}
                  </span>
                  <span className={`num ${l.value === null ? "text-sm text-mustard-ink" : ""}`}>{l.value === null ? tr("lossNoCost") : `−${formatINR(l.value)}`}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {notExp > 0 && (
        <section className="card p-4" aria-labelledby="r-notexp" data-testid="report-notexp">
          <h2 id="r-notexp" className="eyebrow">{tr("notExpTitle")}</h2>
          <dl className="ruled mt-1">
            {r.notExpenses.withdrawal > 0 && <Row label={tr("withdrawal")} value={r.notExpenses.withdrawal} />}
            {r.notExpenses.supplier > 0 && <Row label={tr("supplier")} value={r.notExpenses.supplier} />}
            {r.notExpenses.bank > 0 && <Row label={tr("bank")} value={r.notExpenses.bank} />}
            {!!r.purchases?.paidUpi && <Row label={tr("supplierUpi")} value={r.purchases.paidUpi} />}
            {!!r.purchases?.bills && <Row label={tr("purchases", { count: r.purchases.bills })} value={r.purchases.total} />}
          </dl>
          {!!r.purchases?.bills && (
            <Link href="/suppliers" className="mt-2 inline-flex min-h-12 items-center font-semibold text-teal underline" data-testid="report-suppliers">
              {tr("openSuppliers")}
            </Link>
          )}
          <p className="mt-2 text-sm text-ink-soft">{tr("notExpNote")}</p>
        </section>
      )}
    </>
  );
}

function ItemList({ items, testId, onCheck, showFlags }: { items: ItemRow[]; testId: string; onCheck?: (productId: string) => void; showFlags?: boolean }) {
  const tr = useTranslations("report");
  const t = useTranslations();
  const locale = useLocale() as Locale;
  if (!items.length) return <p className="mt-1 text-ink-soft">{tr("none")}</p>;
  return (
    <ul className="ruled mt-1" data-testid={testId}>
      {items.map((i) => (
        <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2" data-name={i.nameHi}>
          <span className="min-w-0 flex-1">
            <span className="block font-bold">{names(i, locale).primary}</span>
            <span className="num block text-sm text-ink-soft">
              {tr("itemLine", { qty: `${formatNum(i.qty)} ${t(`unit.${i.unit}`)}`, sales: formatINR(i.sales), margin: formatINR(i.margin) })}
            </span>
            {showFlags && i.flags.length > 0 && <span className="block text-sm font-semibold text-mustard-ink">{i.flags.map((f) => tr(`flag_${f}`)).join(" · ")}</span>}
          </span>
          <span className={`num rounded-full px-3 py-1 font-bold ${i.margin < 0 ? "bg-brick/10 text-brick" : "bg-paper-2"}`}>{i.pct === null ? "—" : `${formatNum(i.pct)}%`}</span>
          {onCheck && i.productId && (
            <button type="button" className="btn btn-ghost min-h-12 px-3" onClick={() => onCheck(i.productId)}>
              {t("common.edit")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ItemsSection({ r, onCheck }: { r: ProfitReport; onCheck: (productId: string) => void }) {
  const tr = useTranslations("report");
  const checks = costChecks(r);
  return (
    <>
      <section className="card p-4" aria-labelledby="r-top">
        <h2 id="r-top" className="eyebrow">{tr("topTitle")}</h2>
        <ItemList items={topItems(r)} testId="report-top" />
      </section>
      <section className="card p-4" aria-labelledby="r-low">
        <h2 id="r-low" className="eyebrow">{tr("lowTitle")}</h2>
        <ItemList items={lowMarginItems(r)} testId="report-low" onCheck={onCheck} showFlags />
      </section>
      {checks.length > 0 && (
        <section className="card p-4" aria-labelledby="r-checks">
          <h2 id="r-checks" className="eyebrow">{tr("checksTitle")}</h2>
          <ItemList items={checks} testId="report-checks" onCheck={onCheck} showFlags />
        </section>
      )}
    </>
  );
}

/** Add / fix a buy price right from the report; optionally fill earlier bills that had none. */
function BuyPriceSheet({ productId, offerFill, onClose, onSaved }: { productId: string; offerFill: boolean; onClose: () => void; onSaved: (filled: number) => void }) {
  const tr = useTranslations("report");
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const product = useLiveQuery(() => db.products.get(productId), [productId]) as Product | undefined;
  const [value, setValue] = useState<string | null>(null);
  const [fill, setFill] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!product) return null;
  const v = value ?? (product.buyPrice > 0 ? String(product.buyPrice) : "");
  const num = Number(v);
  const valid = v.trim() !== "" && Number.isFinite(num) && num > 0;
  const save = async () => {
    if (!valid) {
      setError(tr("buyInvalid"));
      return;
    }
    setBusy(true);
    try {
      onSaved(await setBuyPrice(product.id, num, offerFill && fill));
    } catch {
      setError(t("common.saveFailed"));
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={tr("buyTitle", { name: names(product, locale).primary })}
      footer={
        <button type="button" className="btn btn-primary w-full" disabled={busy} onClick={save} data-testid="buy-save">
          {tr("buySave")}
        </button>
      }
    >
      <div className="space-y-3" data-testid="buy-sheet">
        <p className="num text-ink-soft">{tr("sellIs", { amount: formatINR(product.sellPrice) })}</p>
        <label className="block">
          <span className="label">{tr("buyLabel", { unit: t(`unit.${product.unit}`) })}</span>
          <input
            id="buy-price"
            className="input num"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={v}
            autoFocus
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </label>
        {valid && num > product.sellPrice && (
          <p className="rounded-xl bg-brick/10 px-3 py-2 text-sm font-semibold text-brick" role="note">
            {tr("buyAbove")}
          </p>
        )}
        {offerFill && (
          <label className="flex min-h-12 items-start gap-3">
            <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-teal" checked={fill} onChange={(e) => setFill(e.target.checked)} data-testid="buy-fill" />
            <span>
              <span className="block font-semibold">{tr("fillPast")}</span>
              <span className="block text-sm text-ink-soft">{tr("fillPastHint")}</span>
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="font-semibold text-brick">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
