"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconX } from "@/components/Icons";
import { orderErrText, ProductAdder } from "@/components/OrderBits";
import { db, type Basket, type Customer, type Locale } from "@/lib/db";
import { useProducts } from "@/lib/hooks";
import { formatINR, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { fmtQty, qtyForAmount, stepOf } from "@/lib/units";
import { deleteBasket, saveBasket, validQty } from "@/lib/orders";

export default function BasketPage() {
  return (
    <Suspense fallback={<Loading />}>
      <BasketLoader />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

/** ?id=<basket> edits a basket; ?customer=<id> builds a new one by hand. */
function BasketLoader() {
  const shop = useShop();
  const params = useSearchParams();
  const id = params.get("id");
  const cid = params.get("customer");
  const tb = useTranslations("basket");
  const data = useLiveQuery(async () => {
    const basket = id ? await db.baskets.get(id) : undefined;
    const customer = await db.customers.get(basket?.customerId ?? cid ?? "");
    return { basket: basket && basket.shopId === shop.id && !basket.deletedAt ? basket : null, customer: customer && customer.shopId === shop.id ? customer : null };
  }, [shop.id, id, cid]);
  if (!data) return <Loading />;
  if (!data.customer || (id && !data.basket)) return <p className="text-lg">{tb("notFound")}</p>;
  return <BasketForm key={data.basket?.id ?? "new"} basket={data.basket} customer={data.customer} />;
}

function BasketForm({ basket, customer }: { basket: Basket | null; customer: Customer }) {
  const shop = useShop();
  const t = useTranslations();
  const tb = useTranslations("basket");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const products = useProducts(shop.id);
  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const [name, setName] = useState(basket?.name ?? "");
  // Loose lines saved by amount ("₹20 की चीनी") keep it until the quantity is typed over.
  const [lines, setLines] = useState<{ productId: string; qty: string; amount?: number }[]>(() =>
    (basket?.lines ?? []).map((l) => ({ productId: l.productId, qty: String(l.qty), ...(l.amount !== undefined ? { amount: l.amount } : {}) })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = lines.map((l) => {
    const p = byId.get(l.productId);
    const fromAmt = p && l.amount !== undefined ? qtyForAmount(l.amount, p) : null;
    const q = fromAmt ?? Number(l.qty.replace(",", "."));
    return { line: l, product: p, q, amount: fromAmt !== null ? l.amount : undefined, ok: !!p && (fromAmt !== null || (l.qty.trim() !== "" && validQty(q, p.unit))) };
  });
  const total = round2(parsed.reduce((a, x) => a + (x.ok && x.product ? (x.amount ?? x.q * x.product.sellPrice) : 0), 0));
  const back = `/customer?id=${encodeURIComponent(customer.id)}`;

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return setError(tb("err_name"));
    if (!parsed.length || !parsed.every((x) => x.ok)) return setError(t(parsed.length ? "orders.err_qty" : "orders.err_lines"));
    setBusy(true);
    try {
      await saveBasket({ id: basket?.id, shopId: shop.id, customerId: customer.id, name, lines: parsed.map((x) => ({ productId: x.line.productId, qty: x.q, ...(x.amount !== undefined ? { amount: x.amount } : {}) })) });
      router.replace(`${back}&saved=basket`);
    } catch (e) {
      setError(orderErrText(t, e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="basket-form">
      <Link href={back} className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {customer.name}
      </Link>
      <h1 className="font-brand text-4xl font-semibold">{basket ? tb("editTitle") : tb("newTitle")}</h1>
      <p className="text-ink-soft">{tb("forCustomer", { name: customer.name })}</p>
      <div>
        <label className="label" htmlFor="bk-name">
          {tb("name")}
        </label>
        <input id="bk-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tb("namePh")} data-testid="basket-name" />
        <div className="mt-2 flex flex-wrap gap-2">
          {(["suggest1", "suggest2", "suggest3"] as const).map((k) => (
            <button key={k} type="button" className="min-h-12 rounded-full border-2 border-line bg-card px-4 font-semibold" onClick={() => setName(tb(k))}>
              {tb(k)}
            </button>
          ))}
        </div>
      </div>
      <section>
        <h2 className="text-2xl font-bold">{tb("lines")}</h2>
        <ul className="ruled mt-2" data-testid="basket-lines">
          {parsed.map(({ line, product: p, ok, amount, q }, i) => (
            <li key={line.productId} className="flex flex-wrap items-center gap-3 py-3" data-testid="basket-line">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold break-words">{p ? names(p, locale).primary : t("orders.productGone")}</p>
                {p && <p className="num text-sm text-ink-soft">{formatINR(p.sellPrice)} / {t(`unit.${p.unit}`)}</p>}
                {p && amount !== undefined && <p className="num text-sm font-bold" data-testid="basket-amount">{t("sale.byAmountLine", { amount: formatINR(amount), qty: fmtQty(t, q, p.unit) })}</p>}
              </div>
              <label className="flex shrink-0 items-center gap-2">
                <span className="sr-only">{t("orders.qtyFor", { name: p ? names(p, locale).primary : "" })}</span>
                <input
                  className={`input num w-24 text-center ${ok ? "" : "border-brick"}`}
                  inputMode="decimal"
                  value={amount !== undefined ? String(q) : line.qty}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { productId: x.productId, qty: e.target.value } : x)))}
                  aria-label={t("orders.qtyFor", { name: p ? names(p, locale).primary : "" })}
                  data-testid="basket-qty"
                />
                <span className="font-semibold">{p ? t(`unit.${p.unit}`) : ""}</span>
              </label>
              <button type="button" className="icon-btn" aria-label={t("orders.remove")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <IconX />
              </button>
            </li>
          ))}
          {parsed.length === 0 && <li className="py-6 text-ink-soft">{tb("empty")}</li>}
        </ul>
        <div className="mt-3">
          <ProductAdder
            products={products ?? []}
            exclude={new Set(lines.map((l) => l.productId))}
            label={t("orders.addItem")}
            testId="basket-add"
            onPick={(p) => setLines((ls) => [...ls, { productId: p.id, qty: String(stepOf(p)) }])}
          />
        </div>
      </section>
      <div className="flex flex-wrap items-baseline justify-between border-t-2 border-ink/80 pt-3">
        <span className="text-lg font-bold">{t("orders.estimate")}</span>
        <span className="num font-brand text-3xl font-bold">{formatINR(total)}</span>
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-primary min-h-[60px] w-full text-lg" onClick={save} disabled={busy} data-testid="basket-save">
        {busy ? t("common.saving") : tb("save")}
      </button>
      {basket && (
        <button
          type="button"
          className="min-h-12 font-semibold text-brick underline"
          onClick={async () => {
            if (!window.confirm(tb("deleteConfirm", { name: basket.name }))) return;
            await deleteBasket(basket.id);
            router.replace(`${back}&saved=deleted`);
          }}
          data-testid="basket-delete"
        >
          {tb("delete")}
        </button>
      )}
    </div>
  );
}
