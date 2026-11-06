"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { v4 as uuid } from "uuid";
import { useShop } from "@/components/AppShell";
import { IconWhatsApp } from "@/components/Icons";
import { supplierErrText } from "@/components/SupplierSheets";
import { Toast } from "@/components/Toast";
import { useActor } from "@/lib/actor";
import { computeAlerts } from "@/lib/alerts";
import { db, type Locale, type OrderLine, type Product, type Supplier } from "@/lib/db";
import { useNow } from "@/lib/hooks";
import { formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { parseQuantity } from "@/lib/quantity";
import { buildIndex, searchIndex } from "@/lib/search";
import { createOrder, linkProducts, orderGroups, orderText, suggestQty, supplierOf } from "@/lib/suppliers";
import { waLink } from "@/lib/whatsapp";

export default function OrderPage() {
  return (
    <Suspense fallback={<Loading />}>
      <OrderInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function OrderInner() {
  const supplierParam = useSearchParams().get("supplier");
  const shop = useShop();
  const t = useTranslations();
  const to = useTranslations("order");
  const now = useNow();
  const [toast, setToast] = useState<string | null>(null);
  // Kept here, not in the card: sending links the products, which can move them into another card.
  const [sent, setSent] = useState<string | null>(null);
  const data = useLiveQuery(async () => {
    const [suppliers, products, open] = await Promise.all([
      db.suppliers.where("shopId").equals(shop.id).toArray(),
      db.products.where("shopId").equals(shop.id).toArray(),
      db.orders.where("shopId").equals(shop.id).filter((o) => o.status === "ordered").toArray(),
    ]);
    const onOrder = new Map<string, number>();
    for (const o of open) for (const l of o.lines) onOrder.set(l.productId, (onOrder.get(l.productId) ?? 0) + l.qty);
    return { suppliers: suppliers.sort((a, b) => a.name.localeCompare(b.name)), products, onOrder };
  }, [shop.id]);
  if (!data || !now) return <Loading />;

  const alerts = computeAlerts(data.products, shop, now);
  const need = [...alerts.shortage, ...alerts.low];
  const needIds = new Set(need.map((p) => p.id));
  const single = supplierParam ? data.suppliers.find((s) => s.id === supplierParam) : undefined;

  return (
    <div className="space-y-6">
      <Link href={single ? `/suppliers?id=${encodeURIComponent(single.id)}` : "/suppliers"} className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {t("suppliers.back")}
      </Link>
      <h1 className="font-brand text-4xl font-semibold">{single ? to("titleFor", { name: single.name }) : to("title")}</h1>
      <p className="text-ink-soft">{to("intro")}</p>
      {single ? (
        <OrderCard
          supplier={single}
          suppliers={data.suppliers}
          products={data.products.filter((p) => supplierOf(p, data.suppliers)?.id === single.id)}
          allProducts={data.products}
          needIds={needIds}
          onOrder={data.onOrder}
          onToast={setToast}
          onSent={setSent}
          manual
        />
      ) : need.length === 0 ? (
        <p className="rounded-2xl bg-leaf/15 px-5 py-6 text-xl font-bold text-leaf">{to("nothingLow")}</p>
      ) : (
        [...orderGroups(need, data.suppliers)]
          .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : 0))
          .map(([sid, ps]) => (
            <OrderCard
              key={sid || "none"}
              supplier={data.suppliers.find((s) => s.id === sid)}
              suppliers={data.suppliers}
              products={ps}
              allProducts={data.products}
              needIds={needIds}
              onOrder={data.onOrder}
              onToast={setToast}
              onSent={setSent}
            />
          ))
      )}
      {sent && (
        <p className="rounded-xl bg-leaf/15 px-4 py-2 font-semibold text-leaf" data-testid="order-sent">
          {to("sentLine")}{" "}
          <Link href={`/suppliers?id=${encodeURIComponent(sent)}`} className="underline">
            {to("openSupplier")}
          </Link>
        </p>
      )}
      {!single && (
        <p className="text-ink-soft">
          {to("manualHint")}{" "}
          <Link href="/suppliers" className="font-semibold text-teal underline">
            {t("suppliers.title")}
          </Link>
        </p>
      )}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function OrderCard({
  supplier: fixed,
  suppliers,
  products,
  allProducts,
  needIds,
  onOrder,
  onToast,
  onSent,
  manual,
}: {
  supplier?: Supplier;
  suppliers: Supplier[];
  products: Product[];
  allProducts: Product[];
  needIds: Set<string>;
  onOrder: Map<string, number>;
  onToast: (m: string) => void;
  onSent: (supplierId: string) => void;
  manual?: boolean;
}) {
  const shop = useShop();
  const t = useTranslations();
  const to = useTranslations("order");
  const locale = useLocale() as Locale;
  const actor = useActor(shop);
  const [orderId, setOrderId] = useState(() => uuid());
  const [pick, setPick] = useState("");
  const supplier = fixed ?? suppliers.find((s) => s.id === pick);
  // Suggested = reorder target − stock (low / short items only; already ordered items start empty).
  const [extra, setExtra] = useState<string[]>([]);
  const rows = useMemo(() => {
    const list = [...products, ...extra.map((id) => allProducts.find((p) => p.id === id)).filter((p): p is Product => !!p && !products.includes(p))];
    return manual ? list.sort((a, b) => Number(needIds.has(b.id)) - Number(needIds.has(a.id))) : list;
  }, [products, extra, allProducts, manual, needIds]);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(products.map((p) => [p.id, needIds.has(p.id) && !onOrder.has(p.id) ? String(suggestQty(p)) : ""])),
  );
  const [query, setQuery] = useState("");
  const index = useMemo(() => buildIndex(allProducts), [allProducts]);
  const hits = manual && query.trim() ? searchIndex(index, query, { limit: 6 }).map((h) => h.product).filter((p) => !rows.includes(p)) : [];

  const lines: OrderLine[] = rows
    .map((p) => ({ p, q: parseQuantity(qty[p.id] ?? "", p.unit) }))
    .filter((x) => x.q !== null)
    .map(({ p, q }) => ({ productId: p.id, nameHi: p.nameHi, nameEn: p.nameEn, unit: p.unit, qty: q! }));
  const bad = rows.some((p) => (qty[p.id] ?? "").trim() && parseQuantity(qty[p.id], p.unit) === null);
  const text = supplier ? orderText(t, lines, shop, supplier, locale) : "";
  const ready = !!supplier && lines.length > 0 && !bad;

  const onSend = () => {
    if (!supplier) return;
    const id = orderId;
    const unlinked = fixed ? [] : lines.map((l) => l.productId);
    (async () => {
      if (unlinked.length) await linkProducts(unlinked, supplier.id);
      await createOrder({ id, shopId: shop.id, supplierId: supplier.id, lines, byName: actor.name });
    })().then(
      () => {
        onSent(supplier.id);
        setOrderId(uuid());
        onToast(to("saved"));
      },
      (e) => onToast(supplierErrText(t, e)),
    );
  };

  return (
    <section className="card space-y-3 p-4" data-testid="order-card" data-supplier={supplier?.id ?? ""}>
      {fixed ? (
        <h2 className="text-2xl font-bold break-words">{fixed.name}</h2>
      ) : (
        <div>
          <h2 className="text-xl font-bold">{to("noSupplier")}</h2>
          <label className="label" htmlFor="ord-pick">
            {to("pickSupplier")}
          </label>
          <select id="ord-pick" className="input" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="order-pick">
            <option value="">—</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {!suppliers.length && (
            <Link href="/suppliers" className="mt-1 inline-flex min-h-12 items-center font-semibold text-teal underline">
              {to("addSupplierFirst")}
            </Link>
          )}
          <p className="mt-1 text-sm text-ink-soft">{to("linkHint")}</p>
        </div>
      )}
      {supplier && !supplier.phone && <p className="text-sm font-semibold text-mustard-ink">{to("noPhone")}</p>}
      <ul className="ruled">
        {rows.map((p) => {
          const unit = t(`unit.${p.unit}`);
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="order-line">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold break-words">{names(p, locale).primary}</p>
                <p className={`num text-sm ${p.qty < 0 ? "font-bold text-brick" : "text-ink-soft"}`}>
                  {to("stockNow", { qty: `${formatNum(p.qty)} ${unit}` })}
                  {needIds.has(p.id) && <> · {to("suggest", { qty: `${formatNum(suggestQty(p))} ${unit}` })}</>}
                </p>
                {onOrder.has(p.id) && <p className="num text-sm font-semibold text-mustard-ink">{to("alreadyOrdered", { qty: `${formatNum(onOrder.get(p.id)!)} ${unit}` })}</p>}
              </div>
              <label className="flex shrink-0 items-center gap-2">
                <span className="sr-only">{to("qtyFor", { name: names(p, locale).primary })}</span>
                <input
                  className="input num w-24 text-center"
                  inputMode="decimal"
                  value={qty[p.id] ?? ""}
                  placeholder="0"
                  onChange={(e) => setQty((q) => ({ ...q, [p.id]: e.target.value }))}
                  aria-label={to("qtyFor", { name: names(p, locale).primary })}
                  data-testid="order-qty"
                />
                <span className="font-semibold">{unit}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {manual && (
        <div>
          <label className="label" htmlFor="ord-search">
            {to("addItem")}
          </label>
          <input id="ord-search" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("purchase.searchPh")} autoComplete="off" />
          {hits.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {hits.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn btn-ghost min-h-[48px]"
                  onClick={() => {
                    setExtra((x) => [...x, p.id]);
                    setQty((q) => ({ ...q, [p.id]: String(suggestQty(p)) }));
                    setQuery("");
                  }}
                >
                  + {names(p, locale).primary}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {bad && <p className="font-semibold text-brick">{to("badQty")}</p>}
      {ready ? (
        <a href={waLink(text, supplier!.phone)} target="_blank" rel="noreferrer" className="btn btn-wa min-h-[52px] w-full" onClick={onSend} data-testid="order-send">
          <IconWhatsApp /> {to("send", { count: lines.length })}
        </a>
      ) : (
        <button type="button" className="btn btn-wa min-h-[52px] w-full" disabled data-testid="order-send-disabled">
          <IconWhatsApp /> {supplier ? to("sendEmpty") : to("pickFirst")}
        </button>
      )}
      <p className="text-sm text-ink-soft">{to("sendHint")}</p>
    </section>
  );
}
