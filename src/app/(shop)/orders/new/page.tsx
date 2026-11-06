"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconX } from "@/components/Icons";
import { orderErrText, ProductAdder } from "@/components/OrderBits";
import { useActor } from "@/lib/actor";
import { db, type BillAt, type Customer, type Locale, type OrderSource, type Product } from "@/lib/db";
import { useProducts } from "@/lib/hooks";
import { formatINR, formatNum, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { createOrder, lastBillOf, liveBaskets, parseOrderText, pickQty, planRepeat, validQty, type UnmatchedLine } from "@/lib/orders";
import { fmtQty, qtyForAmount, stepOf } from "@/lib/units";

export default function NewOrderPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NewOrderLoader />
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
  guessed?: boolean;
  /** Loose item asked by amount ("20 rupaye ki chini"); dropped once the quantity is typed over. */
  amount?: number;
  /** Asked by amount for a pack: sold by count, so 1 was assumed. */
  amountOnPack?: boolean;
}
interface Init {
  customerId: string;
  lines: Line[];
  source: OrderSource;
  basketId?: string;
}

const qtyText = (n: number) => String(round2(n));

/** Loads what the URL asks for (?customer=, &basket=, &repeat=1) before the form starts. */
function NewOrderLoader() {
  const shop = useShop();
  const params = useSearchParams();
  const customer = params.get("customer") ?? "";
  const basket = params.get("basket");
  const repeat = params.get("repeat") === "1";
  const locale = useLocale() as Locale;
  const init = useLiveQuery(async (): Promise<Init> => {
    const c = customer ? await db.customers.get(customer) : undefined;
    const customerId = c && c.shopId === shop.id ? c.id : "";
    try {
      if (basket) {
        const plan = await planRepeat(shop.id, { basketId: basket }, locale);
        return { customerId: plan.customerId, lines: plan.lines.map((l) => ({ productId: l.product.id, qty: qtyText(l.qty), ...(l.amount !== undefined ? { amount: l.amount } : {}) })), source: "basket", basketId: basket };
      }
      if (repeat && customerId) {
        const plan = await planRepeat(shop.id, { customerId }, locale);
        return { customerId, lines: plan.lines.map((l) => ({ productId: l.product.id, qty: qtyText(l.qty), ...(l.amount !== undefined ? { amount: l.amount } : {}) })), source: "repeat" };
      }
    } catch {
      /* nothing to load: start empty */
    }
    return { customerId, lines: [], source: "manual" };
  }, [shop.id, customer, basket, repeat, locale]);
  // Only the first load matters: the form keeps its own state afterwards.
  if (!init) return <Loading />;
  return <NewOrderForm init={init} />;
}

function NewOrderForm({ init }: { init: Init }) {
  const shop = useShop();
  const t = useTranslations();
  const to = useTranslations("orders");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const actor = useActor(shop);
  const products = useProducts(shop.id);
  const customers = useLiveQuery(() => db.customers.where("shopId").equals(shop.id).sortBy("name"), [shop.id]);
  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);

  const [customerId, setCustomerId] = useState(init.customerId);
  const [newCust, setNewCust] = useState<{ name: string; phone: string; address: string; landmark: string } | null>(null);
  const [lines, setLines] = useState<Line[]>(init.lines);
  const [source, setSource] = useState<OrderSource>(init.source);
  const [basketId, setBasketId] = useState<string | undefined>(init.basketId);
  const [text, setText] = useState("");
  const [pasted, setPasted] = useState("");
  const [unmatched, setUnmatched] = useState<UnmatchedLine[]>([]);
  const [readInfo, setReadInfo] = useState<string | null>(null);
  const [billAt, setBillAt] = useState<BillAt>("delivery");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baskets = useLiveQuery(async () => (customerId ? liveBaskets(await db.baskets.where("customerId").equals(customerId).toArray()) : []), [customerId]);
  const lastBill = useLiveQuery(async () => (customerId ? ((await lastBillOf(customerId)) ?? null) : null), [customerId]);

  const addLine = (p: Product, qty: number, guessed = false, extra: { amount?: number; amountOnPack?: boolean } = {}) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.productId === p.id);
      if (i < 0) return [...ls, { productId: p.id, qty: qtyText(qty), guessed, ...extra }];
      const next = [...ls];
      const cur = Number(next[i].qty) || 0;
      // Two amounts add up; an amount plus a weight keeps the weights only.
      const amount = next[i].amount !== undefined && extra.amount !== undefined ? round2(next[i].amount! + extra.amount) : undefined;
      const fromAmt = amount !== undefined ? qtyForAmount(amount, p) : null;
      next[i] = { productId: p.id, qty: qtyText(fromAmt ?? cur + qty), guessed: next[i].guessed || guessed, ...(fromAmt !== null ? { amount } : {}), ...(next[i].amountOnPack || extra.amountOnPack ? { amountOnPack: true } : {}) };
      return next;
    });
  const addPicked = (p: Product, said: UnmatchedLine["said"]) => {
    const pick = pickQty(said, p);
    addLine(p, pick.qty, pick.guessed, { ...(pick.amount !== undefined ? { amount: pick.amount } : {}), ...(pick.amountOnPack ? { amountOnPack: true } : {}) });
  };

  const read = () => {
    if (!products || !text.trim()) return;
    const r = parseOrderText(text, products);
    for (const l of r.lines) {
      const p = byId.get(l.productId);
      if (p) addLine(p, l.qty, l.qtyGuessed, { ...(l.amount !== undefined ? { amount: l.amount } : {}), ...(l.amountOnPack ? { amountOnPack: true } : {}) });
    }
    setUnmatched((u) => [...u, ...r.unmatched]);
    setPasted((x) => (x ? x + "\n" : "") + text.trim());
    setText("");
    setSource((s) => (s === "manual" ? "paste" : s));
    setReadInfo(to("readResult", { matched: r.lines.length, unmatched: r.unmatched.length }));
  };

  const loadFrom = async (src: { basketId: string } | { customerId: string }) => {
    if (lines.length && !window.confirm(to("replaceLines"))) return;
    try {
      const plan = await planRepeat(shop.id, src, locale);
      setLines(plan.lines.map((l) => ({ productId: l.product.id, qty: qtyText(l.qty), ...(l.amount !== undefined ? { amount: l.amount } : {}) })));
      setSource("basketId" in src ? "basket" : "repeat");
      setBasketId("basketId" in src ? src.basketId : undefined);
      setError(plan.missing.length ? to("missingItems", { names: plan.missing.join(", ") }) : null);
    } catch (e) {
      setError(orderErrText(t, e));
    }
  };

  const parsed = lines.map((l) => {
    const p = byId.get(l.productId);
    const fromAmt = p && l.amount !== undefined ? qtyForAmount(l.amount, p) : null;
    const q = fromAmt ?? Number(l.qty.replace(",", "."));
    return { line: l, product: p, q, amount: fromAmt !== null ? l.amount : undefined, ok: !!p && (fromAmt !== null || (l.qty.trim() !== "" && validQty(q, p.unit))) };
  });
  const total = round2(parsed.reduce((a, x) => a + (x.ok && x.product ? (x.amount ?? x.q * x.product.sellPrice) : 0), 0));
  const hasCustomer = newCust ? !!newCust.name.trim() : !!customerId;
  const ready = hasCustomer && parsed.length > 0 && parsed.every((x) => x.ok);

  const save = async () => {
    if (busy) return;
    if (!hasCustomer) return setError(to("err_customer"));
    if (!parsed.length) return setError(to("err_lines"));
    if (!parsed.every((x) => x.ok)) return setError(to("err_qty"));
    setBusy(true);
    setError(null);
    try {
      const o = await createOrder({
        shopId: shop.id,
        customerId: newCust ? undefined : customerId,
        newCustomer: newCust ?? undefined,
        lines: parsed.map((x) => ({ productId: x.line.productId, qty: x.q, ...(x.amount !== undefined ? { amount: x.amount } : {}) })),
        source,
        basketId,
        text: pasted || undefined,
        unmatched: unmatched.map((u) => u.raw),
        billAt,
        note,
        byName: actor.name,
      });
      router.replace(`/orders?id=${encodeURIComponent(o.id)}`);
    } catch (e) {
      setError(orderErrText(t, e));
      setBusy(false);
    }
  };

  const custList: Customer[] = customers ?? [];

  return (
    <div className="space-y-6" data-testid="order-new">
      <Link href="/orders" className="inline-flex min-h-12 items-center font-semibold text-teal underline">
        ← {to("back")}
      </Link>
      <h1 className="font-brand text-4xl font-semibold">{to("newTitle")}</h1>
      <p className="text-ink-soft">{to("newIntro")}</p>

      {/* Customer */}
      <section className="card space-y-3 p-4">
        <label className="label" htmlFor="no-cust">
          {to("customerLabel")}
        </label>
        {!newCust ? (
          <>
            <select id="no-cust" className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} data-testid="new-customer-select">
              <option value="">{to("pickCustomer")}</option>
              {custList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </select>
            <button type="button" className="min-h-12 font-bold text-teal" onClick={() => setNewCust({ name: "", phone: "", address: "", landmark: "" })} data-testid="new-customer-add">
              {to("newCustomer")}
            </button>
          </>
        ) : (
          <>
            <input id="nc-name" className="input" placeholder={to("custName")} aria-label={to("custName")} value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} />
            <input id="nc-phone" className="input num" inputMode="tel" placeholder={to("custPhone")} aria-label={to("custPhone")} value={newCust.phone} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} />
            <input id="nc-address" className="input" placeholder={to("custAddress")} aria-label={to("custAddress")} value={newCust.address} onChange={(e) => setNewCust({ ...newCust, address: e.target.value })} />
            <input id="nc-landmark" className="input" placeholder={to("custLandmark")} aria-label={to("custLandmark")} value={newCust.landmark} onChange={(e) => setNewCust({ ...newCust, landmark: e.target.value })} />
            <button type="button" className="min-h-12 font-semibold text-ink-soft" onClick={() => setNewCust(null)}>
              ← {to("pickCustomer")}
            </button>
          </>
        )}
        {!newCust && customerId && ((baskets?.length ?? 0) > 0 || lastBill) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {(baskets ?? []).map((b) => (
              <button key={b.id} type="button" className="btn btn-ghost min-h-[48px]" onClick={() => loadFrom({ basketId: b.id })} data-testid="new-from-basket">
                🧺 {b.name}
              </button>
            ))}
            {lastBill && (
              <button type="button" className="btn btn-ghost min-h-[48px]" onClick={() => loadFrom({ customerId })} data-testid="new-from-last">
                ↻ {to("repeatLast")}
              </button>
            )}
          </div>
        )}
      </section>

      {/* Paste */}
      <section className="space-y-2">
        <label className="label" htmlFor="paste-text">
          {to("pasteLabel")}
        </label>
        <textarea id="paste-text" className="input min-h-[140px] py-3" value={text} onChange={(e) => setText(e.target.value)} placeholder={to("pastePh")} data-testid="paste-text" />
        <button type="button" className="btn btn-teal w-full" onClick={read} disabled={!text.trim() || !products} data-testid="paste-read">
          {to("readBtn")}
        </button>
        {readInfo && (
          <p role="status" className="font-semibold" data-testid="paste-result">
            {readInfo}
          </p>
        )}
      </section>

      {unmatched.length > 0 && (
        <section className="space-y-3 rounded-2xl border-2 border-mustard bg-mustard-soft/40 p-4" data-testid="unmatched">
          <p className="font-bold">{to("unmatchedTitle")}</p>
          {unmatched.map((u, i) => (
            <div key={`${u.raw}-${i}`} className="space-y-2 border-t border-line pt-2 first:border-0 first:pt-0" data-testid="unmatched-line">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 font-semibold break-words">“{u.raw}”</p>
                <button type="button" className="min-h-12 px-2 text-sm font-semibold text-ink-soft underline" onClick={() => setUnmatched((x) => x.filter((_, j) => j !== i))} data-testid="unmatched-ignore">
                  {to("ignore")}
                </button>
              </div>
              {u.options.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {u.options.map((id) => byId.get(id)).filter((p): p is Product => !!p).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="btn btn-ghost min-h-[48px]"
                      data-testid="unmatched-pick"
                      onClick={() => {
                        addPicked(p, u.said);
                        setUnmatched((x) => x.filter((_, j) => j !== i));
                      }}
                    >
                      + {names(p, locale).primary}
                    </button>
                  ))}
                </div>
              )}
              <ProductAdder
                products={products ?? []}
                exclude={new Set()}
                label={to("searchFor")}
                testId={`unmatched-search-${i}`}
                onPick={(p) => {
                  addPicked(p, u.said);
                  setUnmatched((x) => x.filter((_, j) => j !== i));
                }}
              />
            </div>
          ))}
        </section>
      )}

      {/* Lines */}
      <section>
        <h2 className="text-2xl font-bold">{to("linesTitle")}</h2>
        <ul className="ruled mt-2" data-testid="new-lines">
          {parsed.map(({ line, product: p, ok, q, amount }, i) => {
            const unit = p ? t(`unit.${p.unit}`) : "";
            return (
              <li key={line.productId} className="flex flex-wrap items-center gap-3 py-3" data-testid="new-line" data-product={p?.nameEn ?? ""}>
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold break-words">{p ? names(p, locale).primary : to("productGone")}</p>
                  {p && (
                    <p className="num text-sm text-ink-soft">
                      {formatINR(p.sellPrice)} / {unit}
                      {ok && <> · {formatINR(amount ?? round2(q * p.sellPrice))}</>}
                    </p>
                  )}
                  {p && amount !== undefined && <p className="num text-sm font-bold" data-testid="new-line-amount">{t("sale.byAmountLine", { amount: formatINR(amount), qty: fmtQty(t, q, p.unit) })}</p>}
                  {line.amountOnPack ? <p className="text-sm font-semibold text-mustard-ink" data-testid="new-line-pack-amount">{to("packAmount")}</p> : line.guessed && <p className="text-sm font-semibold text-mustard-ink">{to("qtyGuess")}</p>}
                  {p && ok && q > Math.max(0, p.qty) && <p className="num text-sm font-semibold text-mustard-ink">{to("stockShort", { qty: `${formatNum(p.qty)} ${unit}` })}</p>}
                </div>
                <label className="flex shrink-0 items-center gap-2">
                  <span className="sr-only">{to("qtyFor", { name: p ? names(p, locale).primary : "" })}</span>
                  <input
                    className={`input num w-24 text-center ${ok ? "" : "border-brick"}`}
                    inputMode="decimal"
                    value={amount !== undefined ? qtyText(q) : line.qty}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { productId: x.productId, qty: e.target.value, guessed: false } : x)))}
                    aria-label={to("qtyFor", { name: p ? names(p, locale).primary : "" })}
                    data-testid="new-line-qty"
                  />
                  <span className="font-semibold">{unit}</span>
                </label>
                <button type="button" className="icon-btn" aria-label={to("remove")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <IconX />
                </button>
              </li>
            );
          })}
          {parsed.length === 0 && <li className="py-6 text-ink-soft">{to("noLines")}</li>}
        </ul>
        <div className="mt-3">
          <ProductAdder products={products ?? []} exclude={new Set(lines.map((l) => l.productId))} label={to("addItem")} testId="new-add" onPick={(p) => addLine(p, stepOf(p))} />
        </div>
      </section>

      {/* Bill point */}
      <fieldset className="space-y-2">
        <legend className="label">{to("billAtTitle")}</legend>
        {(["delivery", "packed"] as const).map((b) => (
          <label key={b} className={`flex min-h-[56px] items-start gap-3 rounded-2xl border-2 px-4 py-3 ${billAt === b ? "border-teal bg-teal/10" : "border-line bg-card"}`}>
            <input type="radio" name="billAt" className="mt-1 h-5 w-5 accent-teal" checked={billAt === b} onChange={() => setBillAt(b)} data-testid={`billat-${b}`} />
            <span>
              <span className="block font-bold">{to(`billAt_${b}`)}</span>
              <span className="block text-sm text-ink-soft">{to(`billAtHint_${b}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <label className="label" htmlFor="no-note">
          {to("noteLabel")}
        </label>
        <input id="no-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {error && (
        <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-baseline justify-between border-t-2 border-ink/80 pt-3">
        <span className="text-lg font-bold">{to("estimate")}</span>
        <span className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] font-bold [overflow-wrap:anywhere]" data-testid="new-total">
          {formatINR(total)}
        </span>
      </div>
      <button type="button" className="btn btn-primary min-h-[64px] w-full text-xl" onClick={save} disabled={busy || !ready} data-testid="order-save">
        {busy ? t("common.saving") : to("save")}
      </button>
    </div>
  );
}
