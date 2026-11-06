"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { v4 as uuid } from "uuid";
import { useShop } from "@/components/AppShell";
import { IconX } from "@/components/Icons";
import { supplierErrText } from "@/components/SupplierSheets";
import { useActor } from "@/lib/actor";
import { dayKey, fmtDate } from "@/lib/dates";
import { db, type Locale, type Product, type Supplier } from "@/lib/db";
import { useNow } from "@/lib/hooks";
import { formatINR, formatNum, parseMoney, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { parseQuantity } from "@/lib/quantity";
import { kindOf } from "@/lib/units";
import { buildIndex, searchIndex } from "@/lib/search";
import { addDaysKey, recordPurchase, supplierOf } from "@/lib/suppliers";

export default function PurchasePage() {
  return (
    <Suspense fallback={<Loading />}>
      <PurchaseInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

interface Line {
  productId: string;
  qty: string;
  price: string;
  ordered?: number;
  /** Packed only: this batch's expiry (optional). */
  expiry?: string;
}

function PurchaseInner() {
  const params = useSearchParams();
  const orderId = params.get("order");
  const shop = useShop();
  const data = useLiveQuery(async () => {
    const [suppliers, products, order] = await Promise.all([
      db.suppliers.where("shopId").equals(shop.id).toArray(),
      db.products.where("shopId").equals(shop.id).toArray(),
      orderId ? db.orders.get(orderId) : Promise.resolve(undefined),
    ]);
    return { suppliers: suppliers.sort((a, b) => a.name.localeCompare(b.name)), products, order: order && order.shopId === shop.id ? order : undefined };
  }, [shop.id, orderId]);
  if (!data) return <Loading />;
  // Keyed so the form starts from the order / supplier once the data is there.
  return <PurchaseForm key={orderId ?? params.get("supplier") ?? ""} {...data} initialSupplier={data.order?.supplierId ?? params.get("supplier") ?? ""} />;
}

function PurchaseForm({
  suppliers,
  products,
  order,
  initialSupplier,
}: {
  suppliers: Supplier[];
  products: Product[];
  order?: { id: string; status: string; lines: { productId: string; qty: number }[] };
  initialSupplier: string;
}) {
  const shop = useShop();
  const t = useTranslations();
  const tp = useTranslations("purchase");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const actor = useActor(shop);
  const now = useNow();
  const today = now ? dayKey(now) : "";
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [id] = useState(() => uuid());
  const [supplierId, setSupplierId] = useState(initialSupplier && suppliers.some((s) => s.id === initialSupplier) ? initialSupplier : "");
  const [day, setDay] = useState(() => dayKey(Date.now()));
  const [billNo, setBillNo] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    (order?.status === "ordered" ? order.lines : [])
      .filter((l) => byId.has(l.productId))
      .map((l) => {
        const p = byId.get(l.productId)!;
        return { productId: l.productId, qty: String(l.qty), price: p.buyPrice > 0 ? String(p.buyPrice) : "", ordered: l.qty };
      }),
  );
  const [cash, setCash] = useState("");
  const [upi, setUpi] = useState("");
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supplier = suppliers.find((s) => s.id === supplierId);
  const index = useMemo(() => buildIndex(products), [products]);
  const inLines = new Set(lines.map((l) => l.productId));
  const hits = query.trim() ? searchIndex(index, query, { limit: 6 }).map((h) => h.product).filter((p) => !inLines.has(p.id)) : [];
  const theirs = supplier ? products.filter((p) => !inLines.has(p.id) && supplierOf(p, suppliers)?.id === supplier.id).slice(0, 8) : [];

  const parsed = lines.map((l) => {
    const p = byId.get(l.productId);
    const qty = p ? parseQuantity(l.qty, p.unit) : null;
    const price = parseMoney(l.price);
    return { ...l, p, qtyN: qty, priceN: price && price > 0 ? price : null, total: qty && price ? round2(qty * price) : 0 };
  });
  const total = round2(parsed.reduce((a, l) => a + l.total, 0));
  const cashN = parseMoney(cash);
  const upiN = parseMoney(upi);
  const credit = cashN !== null && upiN !== null ? round2(total - cashN - upiN) : null;
  const dueDate = credit && credit > 0.005 && supplier?.termsDays !== undefined ? addDaysKey(day, supplier.termsDays) : undefined;
  const linesOk = parsed.length > 0 && parsed.every((l) => l.qtyN !== null && l.priceN !== null);
  const valid = !!supplier && linesOk && credit !== null && credit >= -0.005 && !!day && (!today || day <= today);

  const add = (p: Product) => {
    setLines((ls) => [...ls, { productId: p.id, qty: "", price: p.buyPrice > 0 ? String(p.buyPrice) : "" }]);
    setQuery("");
  };
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    if (!supplier) return setError(tp("errSupplier"));
    if (!linesOk) return setError(tp("errLines"));
    if (credit === null || credit < -0.005) return setError(tp("errPaid"));
    setBusy(true);
    setError(null);
    try {
      await recordPurchase({
        id,
        shopId: shop.id,
        supplierId: supplier.id,
        day,
        billNo,
        lines: parsed.map((l) => ({ productId: l.productId, qty: l.qtyN!, buyPrice: l.priceN!, ...(l.expiry && l.p && kindOf(l.p) === "packed" ? { expiryDate: l.expiry } : {}) })),
        paidCash: cashN ?? 0,
        paidUpi: upiN ?? 0,
        orderId: order?.status === "ordered" ? order.id : undefined,
        note,
        byName: actor.name,
        closedReason: t("suppliers.closedReason"),
      });
      router.replace(`/suppliers?id=${encodeURIComponent(supplier.id)}&saved=1`);
    } catch (e) {
      setError(supplierErrText(t, e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="purchase-form">
      <Link href={supplier ? `/suppliers?id=${encodeURIComponent(supplier.id)}` : "/suppliers"} className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {t("suppliers.back")}
      </Link>
      <h1 className="font-brand text-4xl font-semibold">{order ? tp("titleReceive") : tp("title")}</h1>
      <p className="text-ink-soft">{tp("intro")}</p>
      {order && order.status !== "ordered" && <p className="rounded-xl bg-mustard-soft px-4 py-2 font-semibold">{tp("orderDone")}</p>}

      <section className="space-y-3">
        <div>
          <label className="label" htmlFor="pur-supplier">
            {tp("supplier")}
          </label>
          {suppliers.length ? (
            <select id="pur-supplier" className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={!!order} data-testid="purchase-supplier">
              <option value="">{tp("pickSupplier")}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <Link href="/suppliers" className="btn btn-ghost">
              {tp("addSupplierFirst")}
            </Link>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="pur-day">
              {tp("date")}
            </label>
            <input id="pur-day" type="date" className="input num" max={today || undefined} value={day} onChange={(e) => setDay(e.target.value)} data-testid="purchase-day" />
          </div>
          <div>
            <label className="label" htmlFor="pur-bill">
              {tp("billNo")}
            </label>
            <input id="pur-bill" className="input num" value={billNo} onChange={(e) => setBillNo(e.target.value)} maxLength={40} autoComplete="off" data-testid="purchase-billno" />
          </div>
        </div>
      </section>

      <section aria-labelledby="pur-items" className="space-y-3">
        <h2 id="pur-items" className="eyebrow">
          {tp("items")}
        </h2>
        {lines.length === 0 && <p className="text-ink-soft">{tp("noItems")}</p>}
        <ul className="space-y-3" data-testid="purchase-lines">
          {parsed.map((l, i) => {
            if (!l.p) return null;
            const unit = t(`unit.${l.p.unit}`);
            const changed = l.priceN !== null && l.p.buyPrice > 0 && Math.abs(l.priceN - l.p.buyPrice) > 0.005;
            return (
              <li key={l.productId} className="card space-y-2 p-3" data-testid="purchase-line">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-lg font-bold break-words">{names(l.p, locale).primary}</p>
                  <button type="button" className="icon-btn shrink-0 text-ink-soft" aria-label={t("common.delete")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <IconX />
                  </button>
                </div>
                {l.ordered !== undefined && <p className="num text-sm text-ink-soft">{tp("ordered", { qty: `${formatNum(l.ordered)} ${unit}` })}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label" htmlFor={`pq-${i}`}>
                      {tp("qtyIn", { unit })}
                    </label>
                    <input id={`pq-${i}`} className="input num" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} autoComplete="off" data-testid="line-qty" />
                  </div>
                  <div>
                    <label className="label" htmlFor={`pp-${i}`}>
                      {tp("priceEach", { unit })}
                    </label>
                    <input id={`pp-${i}`} className="input num" inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} autoComplete="off" data-testid="line-price" />
                  </div>
                </div>
                <p className="num font-semibold">
                  {l.total > 0 ? tp("lineTotal", { amount: formatINR(l.total) }) : l.qty && l.qtyN === null ? <span className="text-brick">{tp("badQty")}</span> : "\u00a0"}
                </p>
                {changed && (
                  <p className="num text-sm font-semibold text-mustard-ink" data-testid="line-price-change">
                    {tp("priceChange", { old: formatINR(l.p.buyPrice), now: formatINR(l.priceN!) })}
                  </p>
                )}
                {l.priceN !== null && l.priceN > l.p.sellPrice && l.p.sellPrice > 0 && <p className="text-sm font-semibold text-brick">{tp("aboveSell", { sell: formatINR(l.p.sellPrice) })}</p>}
                {kindOf(l.p) === "packed" && (
                  <div>
                    <label className="label" htmlFor={`pe-${i}`}>
                      {tp("batchExpiry")}
                    </label>
                    <input id={`pe-${i}`} type="date" className="input num" value={l.expiry ?? ""} onChange={(e) => setLine(i, { expiry: e.target.value })} data-testid="line-expiry" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div>
          <label className="label" htmlFor="pur-search">
            {tp("addItem")}
          </label>
          <input id="pur-search" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tp("searchPh")} autoComplete="off" data-testid="purchase-search" />
          {(hits.length > 0 || (!query.trim() && theirs.length > 0)) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {(hits.length ? hits : theirs).map((p) => (
                <button key={p.id} type="button" className="btn btn-ghost min-h-[48px]" onClick={() => add(p)} data-testid="purchase-pick">
                  + {names(p, locale).primary}
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-sm text-ink-soft">
            {tp("newProductHint")}{" "}
            <Link href="/stock" className="font-semibold text-teal underline">
              {t("nav.stock")}
            </Link>
          </p>
        </div>
      </section>

      <section className="card space-y-3 p-4" aria-labelledby="pur-pay">
        <p className="num text-2xl font-extrabold" data-testid="purchase-total">
          {tp("total", { amount: formatINR(total) })}
        </p>
        <h2 id="pur-pay" className="eyebrow">
          {tp("paidNow")}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="pur-cash">
              {tp("cash")}
            </label>
            <input id="pur-cash" className="input num" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} autoComplete="off" placeholder="0" data-testid="purchase-cash" />
          </div>
          <div>
            <label className="label" htmlFor="pur-upi">
              {tp("upi")}
            </label>
            <input id="pur-upi" className="input num" inputMode="decimal" value={upi} onChange={(e) => setUpi(e.target.value)} autoComplete="off" placeholder="0" data-testid="purchase-upi" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost min-h-[48px]" onClick={() => (setCash(String(total)), setUpi(""))} disabled={!total}>
            {tp("allCash")}
          </button>
          <button type="button" className="btn btn-ghost min-h-[48px]" onClick={() => (setCash(""), setUpi(""))}>
            {tp("allCredit")}
          </button>
        </div>
        <p className="text-sm text-ink-soft">{tp("cashHint")}</p>
        {credit === null || credit < -0.005 ? (
          <p className="font-semibold text-brick">{tp("errPaid")}</p>
        ) : (
          <p className={`num text-lg font-bold ${credit > 0.005 ? "text-brick" : "text-leaf"}`} data-testid="purchase-credit">
            {credit > 0.005 ? tp("credit", { amount: formatINR(credit) }) : tp("fullyPaid")}
          </p>
        )}
        {credit !== null && credit > 0.005 && supplier && (
          <p className="num font-semibold" data-testid="purchase-due">
            {dueDate ? tp("dueOn", { date: fmtDate(dueDate, locale, "d MMM yyyy"), days: supplier.termsDays ?? 0 }) : tp("noTerms")}
          </p>
        )}
        <div>
          <label className="label" htmlFor="pur-note">
            {tp("note")}
          </label>
          <input id="pur-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </div>
      </section>

      {error && (
        <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || !valid} onClick={save} data-testid="purchase-save">
        {busy ? t("common.saving") : tp("save", { amount: formatINR(total) })}
      </button>
    </div>
  );
}
