"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconChevron, IconDownload, IconEdit, IconPlus, IconWhatsApp } from "@/components/Icons";
import { SearchBar } from "@/components/SearchBar";
import { AdjustSupplierSheet, DueBadge, PaySupplierSheet, ReturnSheet, supplierErrText, SupplierFormSheet } from "@/components/SupplierSheets";
import { Toast } from "@/components/Toast";
import { downloadCSV, toCSV } from "@/lib/csv";
import { dayKey, fmtDate } from "@/lib/dates";
import { db, type Locale, type PurchaseOrder, type SupplierEntry } from "@/lib/db";
import { useNow } from "@/lib/hooks";
import { formatINR, formatNum, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import {
  cancelOrder,
  dueText,
  entryEffect,
  gallaPaymentsOf,
  loadSupplierRows,
  normName,
  PURCHASES_CSV_HEADERS,
  purchasesCSVRows,
  SUPPLIER_LEDGER_CSV_HEADERS,
  supplierLedgerCSVRows,
  supplierOf,
  SUPPLIERS_CSV_HEADERS,
  suppliersCSVRows,
  supplierStatus,
} from "@/lib/suppliers";

export default function SuppliersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SuppliersInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function SuppliersInner() {
  const id = useSearchParams().get("id");
  return id ? <SupplierDetail key={id} id={id} /> : <SupplierList />;
}

/* ------------------------------ list ------------------------------ */

function SupplierList() {
  const shop = useShop();
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const now = useNow();
  const today = now ? dayKey(now) : "";
  const rows = useLiveQuery(() => (today ? loadSupplierRows(shop.id, today) : undefined), [shop.id, today]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const router = useRouter();

  const list = useMemo(() => {
    const q = normName(query);
    return (rows ?? []).filter((r) => !q || normName(r.supplier.name).includes(q) || normName(r.supplier.items ?? "").includes(q) || (r.supplier.phone ?? "").includes(q));
  }, [rows, query]);
  const owed = round2((rows ?? []).reduce((a, r) => a + Math.max(0, r.status.outstanding), 0));
  const overdue = round2((rows ?? []).reduce((a, r) => a + r.status.overdue, 0));

  const exportCSV = async (kind: "suppliers" | "purchases" | "ledger") => {
    const stamp = dayKey(now);
    const suppliers = await db.suppliers.where("shopId").equals(shop.id).toArray();
    if (kind === "suppliers") downloadCSV(`suppliers-${stamp}.csv`, toCSV(SUPPLIERS_CSV_HEADERS, suppliersCSVRows(rows ?? [])));
    else if (kind === "purchases") downloadCSV(`purchases-${stamp}.csv`, toCSV(PURCHASES_CSV_HEADERS, purchasesCSVRows(await db.purchases.where("shopId").equals(shop.id).toArray(), suppliers)));
    else downloadCSV(`supplier-ledger-${stamp}.csv`, toCSV(SUPPLIER_LEDGER_CSV_HEADERS, supplierLedgerCSVRows(await db.supplierLedger.where("shopId").equals(shop.id).toArray(), suppliers)));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-4xl font-semibold">{ts("title")}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="supplier-add">
          <IconPlus /> {ts("add")}
        </button>
      </div>
      <p className="text-ink-soft">{ts("intro")}</p>

      <section className="card grid gap-1 p-4" data-testid="suppliers-total">
        <p className="eyebrow">{ts("totalOwed")}</p>
        <p className="money-lg num text-3xl font-extrabold">{formatINR(owed)}</p>
        {overdue > 0 && <p className="num font-bold text-brick">{ts("totalOverdue", { amount: formatINR(overdue) })}</p>}
      </section>

      <div className="grid gap-2 sm:grid-cols-2">
        <Link href="/order" className="btn btn-wa min-h-[52px]" data-testid="suppliers-order-low">
          <IconWhatsApp /> {ts("orderLow")}
        </Link>
        <Link href="/purchase" className="btn btn-teal min-h-[52px]" data-testid="suppliers-new-purchase">
          {ts("newPurchase")}
        </Link>
      </div>

      {(rows?.length ?? 0) > 4 && <SearchBar value={query} onChange={setQuery} placeholder={ts("search")} />}

      {rows && rows.length === 0 && <p className="rounded-2xl bg-paper-2 px-5 py-6 text-lg">{ts("empty")}</p>}
      <ul className="ruled" data-testid="supplier-list">
        {list.map(({ supplier: s, status, products, openOrders }) => (
          <li key={s.id}>
            <Link href={`/suppliers?id=${encodeURIComponent(s.id)}`} className="flex min-h-[72px] items-center gap-3 py-3" data-testid="supplier-row">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-xl font-bold break-words">{s.name}</span>
                  <DueBadge state={status.state} />
                </span>
                <span className={`num block font-semibold ${status.outstanding > 0.005 ? "" : "text-ink-soft"}`}>{dueText(t, status, today)}</span>
                <span className="block text-sm text-ink-soft">
                  {[s.items, products ? ts("productsCount", { count: products }) : "", openOrders ? ts("openOrders", { count: openOrders }) : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              <IconChevron className="text-ink-soft" />
            </Link>
          </li>
        ))}
      </ul>

      <section className="space-y-2">
        <h2 className="eyebrow">{ts("exports")}</h2>
        <div className="flex flex-wrap gap-2">
          {(["suppliers", "purchases", "ledger"] as const).map((k) => (
            <button key={k} type="button" className="btn btn-ghost min-h-[48px]" onClick={() => exportCSV(k)} data-testid={`export-${k}`}>
              <IconDownload /> {ts(`csv_${k}`)}
            </button>
          ))}
        </div>
      </section>

      {adding && (
        <SupplierFormSheet
          shopId={shop.id}
          onClose={() => setAdding(false)}
          onSaved={(s) => {
            setAdding(false);
            setToast(t("common.saved"));
            router.push(`/suppliers?id=${encodeURIComponent(s.id)}`);
          }}
        />
      )}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

/* ------------------------------ detail ------------------------------ */

function SupplierDetail({ id }: { id: string }) {
  const shop = useShop();
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const locale = useLocale() as Locale;
  const now = useNow();
  const today = now ? dayKey(now) : "";
  const saved = useSearchParams().get("saved");
  const data = useLiveQuery(async () => {
    const supplier = await db.suppliers.get(id);
    if (!supplier || supplier.shopId !== shop.id) return null;
    const [entries, purchases, orders, products, cash, all] = await Promise.all([
      db.supplierLedger.where("supplierId").equals(id).toArray(),
      db.purchases.where("supplierId").equals(id).toArray(),
      db.orders.where("supplierId").equals(id).toArray(),
      db.products.where("shopId").equals(shop.id).toArray(),
      db.cashEntries.where("shopId").equals(shop.id).toArray(),
      db.suppliers.where("shopId").equals(shop.id).toArray(),
    ]);
    const diaryCash = new Set(entries.map((e) => e.cashEntryId).filter(Boolean));
    return {
      supplier,
      entries: entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.createdAt - b.createdAt)),
      purchases: new Map(purchases.map((p) => [p.id, p])),
      orders: orders.sort((a, b) => b.createdAt - a.createdAt),
      products: products.filter((p) => supplierOf(p, all)?.id === id),
      allProducts: products,
      // Galla supplier payments typed by hand (before the diary or outside it): shown, not counted.
      gallaOnly: gallaPaymentsOf(supplier, cash).filter((e) => !diaryCash.has(e.id)),
    };
  }, [id, shop.id]);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [returning, setReturning] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [toast, setToast] = useState<string | null>(saved ? t("suppliers.purchaseSaved") : null);
  const clearToast = useCallback(() => setToast(null), [setToast]);

  if (data === undefined || !today) return <Loading />;
  if (data === null)
    return (
      <div className="space-y-4">
        <p className="text-lg">{ts("notFound")}</p>
        <Link href="/suppliers" className="btn btn-ghost">
          {ts("back")}
        </Link>
      </div>
    );
  const { supplier: s, entries } = data;
  const status = supplierStatus(entries, today);

  return (
    <div className="space-y-6" data-testid="supplier-detail">
      <Link href="/suppliers" className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {ts("back")}
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-brand text-4xl leading-tight font-semibold break-words">{s.name}</h1>
          {s.phone && (
            <a href={`tel:${s.phone}`} className="num inline-flex min-h-12 items-center font-semibold text-teal underline">
              {s.phone}
            </a>
          )}
        </div>
        <button type="button" className="icon-btn shrink-0 border-2 border-line" aria-label={t("common.edit")} onClick={() => setEditing(true)} data-testid="supplier-edit">
          <IconEdit />
        </button>
      </div>
      {(s.items || s.termsDays !== undefined || s.notes) && (
        <dl className="space-y-1 text-ink-soft">
          {s.items && <p>{ts("itemsLine", { items: s.items })}</p>}
          <p>{s.termsDays === undefined ? ts("noTerms") : s.termsDays === 0 ? ts("termsCash") : ts("termsLine", { days: s.termsDays })}</p>
          {s.notes && <p className="whitespace-pre-line">{s.notes}</p>}
        </dl>
      )}

      <section className={`card space-y-2 p-4 ${status.state === "overdue" ? "border-2 border-brick" : ""}`} data-testid="supplier-balance" data-outstanding={status.outstanding}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow">{status.outstanding < -0.005 ? ts("advanceTitle") : ts("oweTitle")}</p>
          <DueBadge state={status.state} testId="supplier-due-badge" />
        </div>
        <p className={`num text-4xl font-extrabold ${status.state === "overdue" ? "text-brick" : ""}`} data-testid="supplier-outstanding">
          {formatINR(Math.abs(status.outstanding))}
        </p>
        <p className="num font-semibold">{dueText(t, status, today)}</p>
        {status.overdue > 0 && <p className="num font-bold text-brick">{ts("overdueAmount", { amount: formatINR(status.overdue) })}</p>}
        {status.dueSoon > 0 && <p className="num font-bold text-mustard-ink">{ts("dueSoonAmount", { amount: formatINR(status.dueSoon) })}</p>}
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button type="button" className="btn btn-primary min-h-[52px]" onClick={() => setPaying(true)} data-testid="supplier-pay">
            {ts("pay")}
          </button>
          <Link href={`/purchase?supplier=${encodeURIComponent(s.id)}`} className="btn btn-teal min-h-[52px]" data-testid="supplier-purchase">
            {ts("addPurchase")}
          </Link>
          <Link href={`/order?supplier=${encodeURIComponent(s.id)}`} className="btn btn-wa min-h-[52px]" data-testid="supplier-order">
            <IconWhatsApp /> {ts("order")}
          </Link>
          <button type="button" className="btn btn-ghost min-h-[52px]" onClick={() => setReturning(true)} data-testid="supplier-return">
            {ts("returnShort")}
          </button>
        </div>
        <button type="button" className="mt-1 inline-flex min-h-12 items-center font-semibold text-teal underline" onClick={() => setAdjusting(true)} data-testid="supplier-adjust">
          {ts("adjustLink")}
        </button>
      </section>

      <OpenOrders orders={data.orders} onToast={setToast} />

      {status.open.length > 0 && (
        <section aria-labelledby="sup-open">
          <h2 id="sup-open" className="eyebrow">
            {ts("openBills")}
          </h2>
          <ul className="ruled mt-1" data-testid="supplier-open-bills">
            {status.open.map((b) => (
              <li key={b.entryId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">
                    {b.billNo ? ts("billNo", { no: b.billNo }) : ts(b.purchaseId ? "bill" : "adjustEntry")} · {fmtDate(b.day, locale, "d MMM")}
                  </span>
                  <span className="num block text-sm text-ink-soft">
                    {ts("billLeft", { left: formatINR(b.left), total: formatINR(b.amount) })}
                    {b.dueDate && <> · {ts("dueOn", { date: fmtDate(b.dueDate, locale, "d MMM") })}</>}
                  </span>
                </span>
                <DueBadge state={b.state} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="sup-hist">
        <h2 id="sup-hist" className="eyebrow">
          {ts("history")}
        </h2>
        {entries.length === 0 && <p className="mt-1 text-ink-soft">{ts("noHistory")}</p>}
        <LedgerList entries={entries} purchases={data.purchases} />
      </section>

      {data.gallaOnly.length > 0 && (
        <section aria-labelledby="sup-galla" className="rounded-2xl bg-paper-2 p-4">
          <h2 id="sup-galla" className="eyebrow">
            {ts("gallaOnlyTitle")}
          </h2>
          <p className="text-sm text-ink-soft">{ts("gallaOnlyHint")}</p>
          <ul className="ruled mt-1" data-testid="supplier-galla-only">
            {data.gallaOnly.map((e) => (
              <li key={e.id} className="flex justify-between gap-2 py-2">
                <span>
                  {fmtDate(e.day, locale, "d MMM yyyy")}
                  {e.note && <> · {e.note}</>}
                </span>
                <span className="num font-semibold">{formatINR(e.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.products.length > 0 && (
        <section aria-labelledby="sup-prod">
          <h2 id="sup-prod" className="eyebrow">
            {ts("theirProducts")}
          </h2>
          <ul className="ruled mt-1">
            {data.products.map((p) => (
              <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="font-semibold">{names(p, locale).primary}</span>
                <span className="num text-ink-soft">
                  {formatNum(p.qty)} {t(`unit.${p.unit}`)}
                  {p.buyPrice > 0 && <> · {ts("buyAt", { price: formatINR(p.buyPrice) })}</>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && <SupplierFormSheet shopId={shop.id} supplier={s} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), setToast(t("common.saved")))} />}
      {paying && <PaySupplierSheet shop={shop} supplier={s} status={status} onClose={() => setPaying(false)} onDone={setToast} />}
      {returning && <ReturnSheet shop={shop} supplier={s} products={data.products.length ? data.products : data.allProducts} onClose={() => setReturning(false)} onDone={setToast} />}
      {adjusting && <AdjustSupplierSheet shop={shop} supplier={s} onClose={() => setAdjusting(false)} onDone={setToast} />}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

function OpenOrders({ orders, onToast }: { orders: PurchaseOrder[]; onToast: (m: string) => void }) {
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const locale = useLocale() as Locale;
  const open = orders.filter((o) => o.status === "ordered");
  if (!open.length) return null;
  return (
    <section aria-labelledby="sup-orders">
      <h2 id="sup-orders" className="eyebrow">
        {ts("ordersTitle")}
      </h2>
      <ul className="ruled mt-1" data-testid="supplier-orders">
        {open.map((o) => (
          <li key={o.id} className="space-y-2 py-3" data-testid="supplier-order-row">
            <p className="font-bold">{ts("orderedOn", { date: fmtDate(o.createdAt, locale, "d MMM, h:mm a") })}</p>
            <p className="text-ink-soft">{o.lines.map((l) => `${names(l, locale).primary} ${formatNum(l.qty)} ${t(`unit.${l.unit}`)}`).join(", ")}</p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/purchase?order=${encodeURIComponent(o.id)}`} className="btn btn-teal min-h-[48px]" data-testid="order-receive">
                {ts("receive")}
              </Link>
              <button
                type="button"
                className="btn btn-ghost min-h-[48px]"
                onClick={() => {
                  if (window.confirm(ts("cancelOrderConfirm"))) cancelOrder(o.id).then(() => onToast(ts("orderCancelled")), (e) => onToast(supplierErrText(t, e)));
                }}
              >
                {ts("cancelOrder")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LedgerList({ entries, purchases }: { entries: SupplierEntry[]; purchases: Map<string, { lines: { nameHi: string; nameEn: string; qty: number; unit: string }[] }> }) {
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const locale = useLocale() as Locale;
  const rows = entries.reduce<{ e: SupplierEntry; after: number }[]>((acc, e) => [...acc, { e, after: round2((acc.at(-1)?.after ?? 0) + entryEffect(e)) }], []);
  return (
    <ul className="ruled mt-1" data-testid="supplier-ledger">
      {rows.reverse().map(({ e, after }) => {
        const eff = entryEffect(e);
        const p = e.purchaseId && e.type === "purchase" ? purchases.get(e.purchaseId) : undefined;
        return (
          <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-3" data-testid="supplier-ledger-row" data-type={e.type}>
            <span className="min-w-0 flex-1">
              <span className="block font-bold">
                {ts(`type_${e.type}`)}
                {e.method && <> · {t(`sale.${e.method}`)}</>}
                {e.billNo && <> · #{e.billNo}</>}
              </span>
              <span className="block text-sm text-ink-soft">
                {fmtDate(e.day, locale, "d MMM yyyy")}
                {e.dueDate && <> · {ts("dueOn", { date: fmtDate(e.dueDate, locale, "d MMM") })}</>}
                {e.byName && <> · {e.byName}</>}
              </span>
              {p && <span className="block text-sm text-ink-soft">{p.lines.map((l) => `${names(l, locale).primary} ${formatNum(l.qty)} ${t(`unit.${l.unit}`)}`).join(", ")}</span>}
              {(e.reason || e.note) && <span className="block text-sm text-ink-soft">{[e.reason, e.note].filter(Boolean).join(" · ")}</span>}
            </span>
            <span className="text-right">
              <span className={`num block font-extrabold ${eff > 0 ? "text-brick" : "text-leaf"}`}>
                {eff > 0 ? "+" : "−"}
                {formatINR(Math.abs(eff))}
              </span>
              <span className="num block text-sm text-ink-soft">{ts("balanceAfter", { amount: formatINR(after) })}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
