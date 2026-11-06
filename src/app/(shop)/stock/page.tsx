"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { IconEdit, IconMinus, IconPlus } from "@/components/Icons";
import { ProductForm } from "@/components/ProductForm";
import { ProductImportSheet } from "@/components/ProductImportSheet";
import { QuickProductSheet } from "@/components/QuickProductSheet";
import { StockAdjustSheet } from "@/components/StockAdjustSheet";
import { Toast } from "@/components/Toast";
import { SearchBar } from "@/components/SearchBar";
import type { VoiceOutcome } from "@/components/VoiceButton";
import { fmtDate } from "@/lib/dates";
import type { Locale, Product } from "@/lib/db";
import { useAlerts, useNow, useProducts } from "@/lib/hooks";
import { formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { adjustStock } from "@/lib/ops";
import { kindOf, stepOf } from "@/lib/units";
import { OpenPackSheet } from "@/components/OpenPackSheet";
import { buildIndex, closest, searchIndex } from "@/lib/search";

type Filter = "all" | "short" | "low" | "expiring";

export default function StockPage() {
  // useSearchParams (?add=<name> from "no match" on the sale screen) needs a Suspense boundary.
  return (
    <Suspense fallback={<Loading />}>
      <StockInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function StockInner() {
  const shop = useShop();
  const router = useRouter();
  const addParam = useSearchParams().get("add");
  const t = useTranslations();
  const ts = useTranslations("stock");
  const locale = useLocale() as Locale;
  const now = useNow();
  const products = useProducts(shop.id);
  const alerts = useAlerts(shop, now);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [quickEditing, setQuickEditing] = useState<Product | null>(null);
  const [newName, setNewName] = useState("");
  // "/stock?add=चीनी": open the new-product form with that name (once per link).
  const [handledAdd, setHandledAdd] = useState<string | null>(null);
  if (addParam && addParam !== handledAdd) {
    setHandledAdd(addParam);
    setNewName(addParam.slice(0, 60));
    setEditing("new");
  }
  const [scan, setScan] = useState(false);
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [opening, setOpening] = useState<Product | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  const lowIds = useMemo(() => new Set(alerts?.low.map((p) => p.id)), [alerts]);
  const expMap = useMemo(() => new Map(alerts?.expiring.map((p) => [p.id, p.days])), [alerts]);

  // Hindi / Roman / English + aliases + typos (supplier too); ranked while searching, A–Z otherwise.
  const index = useMemo(() => buildIndex(products ?? [], (p) => [p.supplier]), [products]);
  const list = useMemo(() => {
    const inFilter = (p: Product) => (filter === "short" ? p.qty < 0 : filter === "low" ? lowIds.has(p.id) : filter === "expiring" ? expMap.has(p.id) : true);
    if (query.trim()) return searchIndex(index, query).map((h) => h.product).filter(inFilter);
    return (products ?? []).filter(inFilter).sort((a, b) => names(a, locale).primary.localeCompare(names(b, locale).primary, locale));
  }, [products, index, query, filter, lowIds, expMap, locale]);

  const addNew = (name = "") => {
    setNewName(name);
    setEditing("new");
  };
  const onVoice = (alternatives: string[]): VoiceOutcome => {
    const text = alternatives.find((a) => searchIndex(index, a, { limit: 1 }).length) ?? alternatives[0] ?? "";
    setQuery(text);
    if (text && !searchIndex(index, text, { limit: 1 }).length) return { kind: "nomatch", text, closest: closest(index, text).map((p) => ({ id: p.id, label: names(p, locale).primary })) };
  };
  const closeForm = () => {
    setEditing(null);
    if (addParam) router.replace("/stock");
  };

  const onScan = useCallback(
    (code: string) => {
      setScan(false);
      const p = (products ?? []).find((x) => x.barcode === code);
      if (p) setEditing(p);
      else setQuery(code);
    },
    [products],
  );

  const shortCount = alerts?.shortage.length ?? 0;
  const filters: [Filter, string, number?][] = [
    ["all", ts("all"), products?.length],
    ...(shortCount || filter === "short" ? ([["short", ts("short"), shortCount]] as [Filter, string, number][]) : []),
    ["low", ts("low"), alerts?.low.length],
    ["expiring", ts("expiring"), alerts?.expiring.length],
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-4xl font-semibold">{ts("title")}</h1>
        <button type="button" className="btn btn-primary" onClick={() => addNew()}>
          <IconPlus /> {ts("add")}
        </button>
      </div>
      {/* Supplier diary: reachable from here and from More (the bottom bar stays at 5). */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost min-h-[48px]" onClick={() => setImporting(true)}>{t("import.open")}</button>
        <Link href="/suppliers" className="btn btn-ghost min-h-[48px]" data-testid="stock-suppliers">
          {ts("suppliersLink")}
        </Link>
        <Link href="/purchase" className="btn btn-ghost min-h-[48px]" data-testid="stock-purchase">
          {ts("purchaseLink")}
        </Link>
      </div>

      <div className="sticky top-0 z-20 -mx-4 mt-3 space-y-2 bg-paper/90 px-4 py-2 backdrop-blur">
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder={ts("search")}
          onScan={() => setScan(true)}
          onVoice={onVoice}
          onVoicePick={(id) => {
            const p = products?.find((x) => x.id === id);
            if (p) setEditing(p);
          }}
          onVoiceAdd={addNew}
        />
        <div className="flex flex-wrap gap-2" role="tablist">
          {filters.map(([k, label, c]) => (
            <button
              key={k}
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={`min-h-[48px] rounded-full border-2 px-4 font-bold ${filter === k ? (k === "short" ? "border-brick bg-brick text-paper" : "border-teal bg-teal text-paper") : k === "short" ? "border-brick/60 bg-card text-brick" : "border-line bg-card"}`}
            >
              {label} <span className="num font-semibold">{c ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <ul className="mt-2 space-y-2">
        {list.map((p) => {
          const n = names(p, locale);
          const days = expMap.get(p.id);
          const low = lowIds.has(p.id);
          const short = p.qty < 0;
          const step = stepOf(p);
          return (
            <li key={p.id} className="card flex flex-wrap items-center justify-end gap-2 p-3">
              <button type="button" onClick={() => setQuickEditing(p)} className="min-h-[56px] min-w-[min(100%,11rem)] flex-1 text-left" aria-label={t("quickProduct.openFor", { name: n.primary })}>
                <span className="flex items-center gap-2">
                  <span className="min-w-0 text-lg font-bold break-words">{n.primary}</span>
                  <IconEdit width={16} height={16} className="shrink-0 text-ink-soft" />
                </span>
                <span className="line-clamp-2 block text-sm text-ink-soft">
                  ₹{formatNum(p.sellPrice)}/{t(`unit.${p.unit}`)}
                  {" · "}{ts(kindOf(p) === "loose" ? "kindLoose" : "kindPacked")}
                  {n.secondary && <> · {n.secondary}</>}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {short && <span className="rounded-full bg-brick px-2 text-sm font-bold text-paper">{ts("shortTag")}</span>}
                  {low && <span className="rounded-full bg-brick/12 px-2 text-sm font-bold text-brick">{ts("lowTag")}</span>}
                  {days !== undefined && p.expiryDate && (
                    <span className="rounded-full bg-mustard-soft px-2 text-sm font-bold text-ink">
                      {days < 0 ? ts("expiredTag") : ts("expTag", { date: fmtDate(p.expiryDate, locale) })}
                    </span>
                  )}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => adjustStock(p.id, -step)} className="icon-btn border-2 border-line bg-card" aria-label="-">
                  <IconMinus />
                </button>
                <button
                  type="button"
                  onClick={() => setAdjusting(p)}
                  aria-label={ts("adjustFor", { name: n.primary })}
                  className={`num min-h-[48px] min-w-[3.6rem] rounded-xl text-center underline decoration-dotted underline-offset-4 ${short || low ? "text-brick" : ""} ${short ? "bg-brick/10" : ""}`}
                >
                  <span className="block text-2xl leading-none font-extrabold">{formatNum(p.qty)}</span>
                  <span className={`text-xs font-semibold ${short || low ? "" : "text-ink-soft"}`}>{t(`unit.${p.unit}`)}</span>
                </button>
                <button type="button" onClick={() => adjustStock(p.id, step)} className="icon-btn bg-teal text-paper" aria-label="+">
                  <IconPlus />
                </button>
              </div>
              {kindOf(p) === "packed" && p.looseId && p.packSize ? (
                <button type="button" onClick={() => setOpening(p)} className="min-h-12 w-full rounded-xl border-2 border-teal px-3 text-left font-bold text-teal" data-testid={`open-pack-${p.id}`}>
                  {ts("openPackBtn")}
                </button>
              ) : null}
            </li>
          );
        })}
        {products && list.length === 0 && (
          <li className="py-10 text-center text-lg text-ink-soft">
            {ts("none")}
            {query.trim() && (
              <button type="button" className="mt-3 block w-full min-h-12 font-semibold text-teal underline" onClick={() => addNew(query.trim())}>
                {t("voice.addProduct", { text: query.trim() })}
              </button>
            )}
          </li>
        )}
      </ul>

      {editing && (
        <ProductForm
          key={editing === "new" ? "new" : editing.id}
          shopId={shop.id}
          product={editing === "new" ? undefined : editing}
          initialName={editing === "new" ? newName : undefined}
          onClose={closeForm}
          onAdjust={(p) => {
            closeForm();
            setAdjusting(p);
          }}
        />
      )}
      {importing && <ProductImportSheet shopId={shop.id} products={products ?? []} onClose={() => setImporting(false)} onSaved={setToast} />}
      {quickEditing && <QuickProductSheet key={quickEditing.id} shopId={shop.id} product={quickEditing} onClose={() => setQuickEditing(null)} onSaved={setToast} onDetails={setEditing} />}
      {opening && <OpenPackSheet key={opening.id} product={opening} onClose={() => setOpening(null)} onSaved={setToast} />}
      {adjusting && <StockAdjustSheet key={adjusting.id} product={adjusting} onClose={() => setAdjusting(null)} onSaved={setToast} />}
      <Toast message={toast} onDone={clearToast} />
      <BarcodeScanner open={scan} onClose={() => setScan(false)} onDetected={onScan} />
    </div>
  );
}
