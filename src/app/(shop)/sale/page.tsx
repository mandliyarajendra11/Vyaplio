"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState, type SetStateAction } from "react";
import { useShop } from "@/components/AppShell";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { SaleStamp } from "@/components/SaleStamp";
import { ReceiptPrint } from "@/components/ReceiptPrint";
import { ItemDiscount } from "@/components/ItemDiscount";
import { IconWhatsApp } from "@/components/Icons";
import { SearchBar } from "@/components/SearchBar";
import type { VoiceOutcome } from "@/components/VoiceButton";
import { Sheet } from "@/components/Sheet";
import { SaleQuantity } from "@/components/SaleQuantity";
import { PaymentPanel, type UpiChoice } from "@/components/PaymentPanel";
import { Toast } from "@/components/Toast";
import { db, type Locale, type PaymentType, type Product, type Sale, type SaleDraft } from "@/lib/db";
import { emptySaleDraft } from "@/lib/saleDraft";
import { useSaleDraft } from "@/lib/useSaleDraft";
import { useCustomers, useProducts } from "@/lib/hooks";
import { formatINR, formatNum, round2, parseMoney } from "@/lib/money";
import { names } from "@/lib/names";
import { recordSale } from "@/lib/ops";
import { discountAmount, roundOffAmount, DiscountError, type BillDiscount } from "@/lib/discounts";
import { fmtQty, kindOf, lineTotal, qtyForAmount, stepOf } from "@/lib/units";
import { WeightPicker, type PickMode } from "@/components/WeightPicker";
import { buildIndex, closest, searchIndex, Tier } from "@/lib/search";
import { parseSpokenQuantity, qtyForProduct } from "@/lib/voiceParse";
import { formPlan, paymentsOf, PAY_METHODS, PaymentError, type PaymentRequest, type SplitForm } from "@/lib/payments";
import { useSaveAction } from "@/lib/useSaveAction";
import { billText } from "@/lib/share";
import { waLink } from "@/lib/whatsapp";

export default function SalePage() {
  const shop = useShop();
  const t = useTranslations("common");
  const [attempt, setAttempt] = useState(0);
  const loaded = useLiveQuery(async () => {
    try {
      return { draft: (await db.saleDrafts.get(shop.id)) ?? emptySaleDraft(shop.id) };
    } catch {
      return { draft: null };
    }
  }, [shop.id, attempt]);
  if (!loaded) return <p role="status">{t("loading")}</p>;
  if (!loaded.draft) return <div role="alert"><p>{t("saveFailed")}</p><button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>{t("retry")}</button></div>;
  return <SaleEditor key={shop.id} initialDraft={loaded.draft} />;
}

function SaleEditor({ initialDraft }: { initialDraft: SaleDraft }) {
  const shop = useShop();
  const t = useTranslations();
  const ts = useTranslations("sale");
  const locale = useLocale() as Locale;
  const products = useProducts(shop.id);
  const customers = useCustomers(shop.id);

  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const { draft, update, status, resetAfterSale } = useSaleDraft(initialDraft);
  const { cart, payment, customerId, newCust } = draft;
  const amounts = useMemo(() => draft.amounts ?? {}, [draft.amounts]);
  const repeat = draft.repeat ?? null;
  const split = draft.split ?? null;
  const setCart = useCallback((value: SetStateAction<Record<string, number>>) => update((d) => ({ ...d, cart: typeof value === "function" ? value(d.cart) : value })), [update]);
  const setPayment = (payment: PaymentType) => update((d) => ({ ...d, payment }));
  const setSplit = (split: SplitForm | null) => update((d) => ({ ...d, split }));
  // Counter-only details (not part of the saved draft): notes handed over and the UPI check.
  const [tendered, setTendered] = useState("");
  const [upi, setUpi] = useState<UpiChoice>(null);
  const [upiRef, setUpiRef] = useState("");
  const setCustomerId = (customerId: string) => update((d) => ({ ...d, customerId }));
  const setNewCust = (newCust: SaleDraft["newCust"]) => update((d) => ({ ...d, newCust }));
  const [checkout, setCheckout] = useState(false);
  // Cash / UPI bills can carry a customer too (repeat orders, delivery) — only when asked for.
  const [custOpen, setCustOpen] = useState(false);
  const [done, setDone] = useState<Sale | null>(null);
  const [scan, setScan] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Loose item being weighed / sold by amount (the weight + ₹ picker).
  const [picker, setPicker] = useState<{ id: string; mode: PickMode } | null>(null);
  const { busy, failed, run } = useSaveAction();
  const clearToast = useCallback(() => setToast(null), []);

  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  // Hindi / Roman / English + aliases + small typos; best-sellers first within each rank.
  const index = useMemo(() => buildIndex(products ?? []), [products]);
  const list = useMemo(() => searchIndex(index, query).map((h) => h.product), [index, query]);
  const suggestions = useMemo(() => (query.trim() && !list.length ? closest(index, query) : []), [index, query, list.length]);
  // Sold by amount: qty follows today's price (exactly as the bill will make it); the line total is the amount.
  const lines = Object.entries(cart)
    .map(([id, qty]) => {
      const product = byId.get(id);
      const amount = amounts[id];
      const fromAmt = product && amount !== undefined ? qtyForAmount(amount, product) : null;
      return { product, qty: fromAmt ?? qty, amount: fromAmt !== null ? amount : undefined };
    })
    .filter((l): l is { product: Product; qty: number; amount: number | undefined } => !!l.product && l.qty > 0)
    .map((l) => {
      const input = draft.itemDiscounts?.[l.product.id];
      const request: BillDiscount | undefined = input ? { kind: input.kind, value: parseMoney(input.value) ?? NaN } : undefined;
      const gross = lineTotal({ qty: l.qty, price: l.product.sellPrice, amount: l.amount });
      let itemDiscount = 0;
      let invalid = false;
      try { itemDiscount = discountAmount(gross, request); } catch { invalid = true; }
      return { ...l, discountRequest: request, itemDiscount, discountInvalid: invalid, net: round2(gross - itemDiscount) };
    });
  const subtotal = round2(lines.reduce((a, l) => a + lineTotal({ qty: l.qty, price: l.product.sellPrice, amount: l.amount }), 0));
  const itemDiscounts = round2(lines.reduce((a, l) => a + l.itemDiscount, 0));
  const afterItems = round2(subtotal - itemDiscounts);
  const invalidItem = lines.find((l) => l.discountInvalid);
  const parsedDiscount = draft.discount ? parseMoney(draft.discount.value) : 0;
  const discountRequest: BillDiscount | undefined = draft.discount ? { kind: draft.discount.kind, value: parsedDiscount ?? NaN } : undefined;
  let discount = 0;
  let discountInvalid = false;
  try { discount = discountAmount(afterItems, discountRequest); } catch { discountInvalid = true; }
  const beforeRounding = round2(afterItems - discount);
  const rounding = draft.roundToRupee ? roundOffAmount(beforeRounding) : 0;
  const total = round2(beforeRounding + rounding);
  // Selling more than recorded is allowed (never block the counter); just say so before confirming.
  const overLines = lines.filter((l) => l.qty > Math.max(0, l.product.qty));
  const missingProducts = !!products && Object.keys(cart).some((id) => !byId.has(id));
  const plan = formPlan(total, payment, split);
  const needsCustomer = plan.amounts.credit > 0;
  const showCustomer = needsCustomer || custOpen || !!repeat;
  const repeatCustomer = repeat ? customers?.find((c) => c.id === repeat.customerId) : undefined;
  // Repeat: today's price differs from the basket / old bill (shown, never blocking).
  const priceChanges = repeat ? lines.filter((l) => repeat.prices[l.product.id] !== undefined && Math.abs(repeat.prices[l.product.id] - l.product.sellPrice) > 0.005) : [];
  const upiReady = plan.amounts.upi <= 0 || (!!upi && upi.amount === plan.amounts.upi);

  /** Set a quantity (a weight / count change ends "sold by amount" for that line). */
  const setQty = (id: string, qty: number) =>
    update((d) => {
      const cart = { ...d.cart };
      if (qty <= 0) delete cart[id];
      else cart[id] = qty;
      const amounts = { ...(d.amounts ?? {}) };
      delete amounts[id];
      const itemDiscounts = { ...d.itemDiscounts };
      if (qty <= 0) delete itemDiscounts[id];
      return { ...d, cart, amounts, itemDiscounts };
    });
  const setItemDiscount = (id: string, input: NonNullable<SaleDraft["itemDiscounts"]>[string] | null) => update((d) => {
    const itemDiscounts = { ...d.itemDiscounts };
    if (input) itemDiscounts[id] = input;
    else delete itemDiscounts[id];
    return { ...d, itemDiscounts };
  });
  /** "₹20 का सामान": keep the amount; qty is derived from it. */
  const setAmount = (id: string, amount: number, qty: number) =>
    update((d) => ({ ...d, cart: { ...d.cart, [id]: qty }, amounts: { ...(d.amounts ?? {}), [id]: amount } }));
  // Packs: one tap = one more. Loose: one tap opens the weight / ₹ picker.
  const addOne = (p: Product) => {
    if (kindOf(p) === "loose") setPicker({ id: p.id, mode: "weight" });
    else setQty(p.id, round2((cart[p.id] ?? 0) + 1));
  };

  /**
   * Spoken words: "do kilo chini" puts 2 kg चीनी on the bill when exactly one product clearly
   * matches and the quantity fits its unit; otherwise the words go into the search box.
   */
  const onVoice = (alternatives: string[]): VoiceOutcome => {
    let first: { text: string; said: ReturnType<typeof parseSpokenQuantity> } | null = null;
    for (const alt of alternatives) {
      const said = parseSpokenQuantity(alt);
      const text = said.rest || alt;
      first ??= { text, said };
      const hits = searchIndex(index, text, { limit: 2 });
      if (!hits.length) continue;
      const top = hits[0];
      const clear = top.tier >= Tier.Alias && (hits.length === 1 || hits[1].tier < top.tier);
      if (said.money && said.amount !== undefined && clear) {
        // "20 rupaye ki chini": loose → that ₹ amount; a pack is sold by count, so explain instead.
        const p = top.product;
        const name = names(p, locale).primary;
        const q = qtyForAmount(said.amount, p);
        if (kindOf(p) === "packed") setToast(t("voice.packedAmount", { name }));
        else if (q === null) setToast(t("voice.amountTooSmall", { name }));
        else {
          setAmount(p.id, said.amount, q);
          setToast(t("voice.addedAmount", { name, amount: formatINR(said.amount), qty: fmtQty(t, q, p.unit) }));
        }
        setQuery("");
        return;
      }
      if (said.qty === null || !clear) {
        setQuery(text);
        return;
      }
      const p = top.product;
      const qty = qtyForProduct(said, p.unit);
      const name = names(p, locale).primary;
      if (qty === null) {
        addOne(p);
        setToast(t("voice.qtyCheck", { name }));
      } else {
        setQty(p.id, qty);
        setToast(t("voice.added", { name, qty: `${formatNum(qty)} ${t(`unit.${p.unit}`)}` }));
      }
      setQuery("");
      return;
    }
    const text = first?.text ?? "";
    setQuery(text);
    if (!text) return;
    return { kind: "nomatch", text, closest: closest(index, text).map((p) => ({ id: p.id, label: names(p, locale).primary })) };
  };
  const pickProduct = (id: string) => {
    const p = byId.get(id);
    if (p) {
      addOne(p);
      setQuery("");
    }
  };

  const onScan = useCallback(
    (code: string) => {
      setScan(false);
      const p = (products ?? []).find((x) => x.barcode === code);
      if (p) setCart((c) => ({ ...c, [p.id]: round2((c[p.id] ?? 0) + stepOf(p)) }));
      else setToast(ts("scanNotFound"));
    },
    [products, ts, setCart],
  );

  const tenderedNum = tendered.trim() ? (parseMoney(tendered) ?? NaN) : undefined;
  const checkoutIssue = invalidItem ? t("discount.itemError", { name: names(invalidItem.product, locale).primary }) : discountInvalid ? t("discount.invalid") : plan.invalid || Math.abs(plan.left) > 0.005 ? t("pay.errSum")
    : needsCustomer && (newCust ? !newCust.name.trim() : !customerId) ? t("pay.errCustomer")
    : tenderedNum !== undefined && plan.amounts.cash > 0 && !(tenderedNum >= plan.amounts.cash) ? t("pay.errTendered")
    : !upiReady ? t("pay.upiChoose") : null;

  const confirm = async () => {
    if (!lines.length || busy || missingProducts) return;
    if (checkoutIssue) return setToast(checkoutIssue);
    const payments: PaymentRequest[] = PAY_METHODS.filter((m) => plan.amounts[m] > 0).map((m) => ({
      method: m,
      amount: plan.amounts[m],
      tendered: m === "cash" ? tenderedNum : undefined,
      upi: m === "upi" ? upi?.state : undefined,
      ref: m === "upi" && upi?.state === "paid" ? upiRef : undefined,
    }));
    await run(async () => {
      try {
        const sale = await recordSale({
          shopId: shop.id,
          lines: lines.map((l) => ({ product: l.product, qty: l.qty, discount: l.discountRequest, ...(l.amount !== undefined ? { amount: l.amount } : {}) })),
          payment,
          roundToRupee: !!draft.roundToRupee,
          discount: discountRequest,
          payments: payments.length ? payments : undefined,
          customerId: showCustomer ? customerId || undefined : undefined,
          newCustomer: showCustomer ? (newCust ?? undefined) : undefined,
          draftId: draft.id,
        });
        setDone(sale);
        resetAfterSale();
        setSelectedOnly(false);
        setCheckout(false);
        setQuery("");
        setTendered("");
        setUpi(null);
        setUpiRef("");
        setCustOpen(false);
      } catch (e) {
        if (e instanceof DiscountError) { setToast(t("discount.invalid")); return; }
        if (!(e instanceof PaymentError)) throw e;
        setToast(t(e.code === "customer" ? "pay.errCustomer" : e.code === "tendered" ? "pay.errTendered" : e.code === "upiChoice" ? "pay.upiChoose" : "pay.errSum"));
      }
    });
  };

  const doneCustomer = done?.customerId ? customers?.find((c) => c.id === done.customerId) : undefined;
  const count = lines.length;
  const shownProducts = selectedOnly ? lines.map((l) => l.product) : list;

  return (
    <div className={count > 0 ? "pb-28 lg:pb-0" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between">
        <h1 className="font-brand text-4xl font-semibold">{ts("title")}</h1>
        <span className="flex flex-wrap gap-x-4">
          <Link href="/orders" className="min-h-[48px] content-center font-semibold text-teal" data-testid="sale-orders">
            {ts("ordersLink")} →
          </Link>
          <Link href="/sales" className="min-h-[48px] content-center font-semibold text-teal">
            {t("nav.sales")} →
          </Link>
        </span>
      </div>

      {repeat && (
        <div role="status" className="mt-3 rounded-2xl border-2 border-teal bg-teal/10 px-4 py-3" data-testid="repeat-banner">
          <p className="font-bold break-words">
            ↻ {ts(repeat.kind === "basket" ? "repeatBasket" : "repeatBill", { label: repeat.label, name: repeatCustomer?.name ?? "—" })}
          </p>
          {priceChanges.length > 0 && (
            <ul className="mt-1 text-sm" data-testid="repeat-price-changes">
              {priceChanges.map((l) => (
                <li key={l.product.id} className="num font-semibold text-mustard-ink">
                  {ts("repeatPrice", { name: names(l.product, locale).primary, old: formatINR(repeat.prices[l.product.id]), now: formatINR(l.product.sellPrice) })}
                </li>
              ))}
            </ul>
          )}
          {overLines.length > 0 && (
            <ul className="mt-1 text-sm" data-testid="repeat-short">
              {overLines.map(({ product: p, qty }) => (
                <li key={p.id} className="num font-semibold text-brick">
                  {p.qty <= 0 ? ts("repeatOut", { name: names(p, locale).primary }) : ts("shortWarnLine", { name: names(p, locale).primary, have: `${formatNum(p.qty)} ${t(`unit.${p.unit}`)}`, sell: `${formatNum(qty)} ${t(`unit.${p.unit}`)}` })}
                </li>
              ))}
            </ul>
          )}
          {repeat.missing.length > 0 && (
            <p className="mt-1 text-sm font-semibold text-brick" data-testid="repeat-missing">
              {ts("repeatMissing", { names: repeat.missing.join(", ") })}
            </p>
          )}
          <p className="mt-1 text-sm text-ink-soft">{ts("repeatHint")}</p>
        </div>
      )}

      {status === "failed" ? <p role="alert" className="mt-3 text-brick">{ts("draftFailed")} <button type="button" className="min-h-12 font-bold underline" onClick={() => update((d) => ({ ...d }))}>{t("common.retry")}</button></p>
        : Object.keys(cart).length > 0 && <p role="status" className="mt-3 text-sm text-ink-soft">{ts(status === "saving" ? "draftSaving" : "draftSaved")}</p>}
      {missingProducts && <div role="alert" className="mt-3 text-brick">
        <p>{ts("draftMissing")}</p>
        <button type="button" className="min-h-12 font-bold underline" onClick={() => setCart((c) => Object.fromEntries(Object.entries(c).filter(([id]) => byId.has(id))))}>{ts("removeMissing")}</button>
      </div>}

      <div className="sticky top-0 z-20 -mx-4 mt-3 bg-paper/90 px-4 py-2 backdrop-blur">
        <SearchBar value={query} onChange={(value) => { setQuery(value); setSelectedOnly(false); }} placeholder={ts("search")} onScan={() => setScan(true)} onVoice={onVoice} onVoicePick={pickProduct} />
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={ts("showItems")}>
          <button type="button" aria-pressed={!selectedOnly} onClick={() => { setSelectedOnly(false); setQuery(""); }}
            className={`min-h-12 rounded-xl border-2 px-3 font-bold ${!selectedOnly ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}>{ts("allItems")}</button>
          <button type="button" aria-pressed={selectedOnly} onClick={() => { setSelectedOnly(true); setQuery(""); }}
            className={`min-h-12 rounded-xl border-2 px-3 font-bold ${selectedOnly ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}>{ts("selectedItems", { count })}</button>
        </div>
        {!selectedOnly && !query && <p className="mt-1.5 text-sm text-ink-soft">{ts("popular")}</p>}
      </div>

      <ul className="mt-2 space-y-2">
        {shownProducts.map((p) => {
          const n = names(p, locale);
          const line = lines.find((l) => l.product.id === p.id);
          const inCart = line?.qty ?? 0;
          const loose = kindOf(p) === "loose";
          return (
            <li key={p.id} className={`card flex flex-wrap items-center gap-3 p-3 ${inCart ? "border-teal ring-2 ring-teal/30" : ""}`}>
              <button type="button" onClick={() => addOne(p)} className="flex min-h-[60px] min-w-0 flex-1 flex-col items-start justify-center text-left" data-testid={`sale-item-${p.id}`}>
                <span className="w-full break-words text-xl font-bold">{n.primary}</span>
                <span className="line-clamp-2 w-full text-sm text-ink-soft">
                  {n.secondary && <>{n.secondary} · </>}
                  <span className={p.qty <= 0 ? "font-bold text-brick" : p.qty <= p.lowStockAt ? "font-bold text-mustard-ink" : ""}>
                    {p.qty < 0
                      ? ts("negative", { qty: `${formatNum(p.qty)} ${t(`unit.${p.unit}`)}` })
                      : p.qty === 0
                        ? ts("out")
                        : ts("left", { qty: `${formatNum(p.qty)} ${t(`unit.${p.unit}`)}` })}
                  </span>
                </span>
              </button>
              {inCart ? (
                <div className="w-full space-y-2">
                  <p className="num text-ink-soft">
                    {formatINR(p.sellPrice)} / {t(`unit.${p.unit}`)} · <b className="text-ink">{formatINR(lineTotal({ qty: inCart, price: p.sellPrice, amount: line?.amount }))}</b>
                    {line?.amount !== undefined && <span className="ml-2 rounded-lg bg-mustard-soft px-2 font-bold text-ink" data-testid="sale-line-amount">{ts("byAmountLine", { amount: formatINR(line.amount), qty: fmtQty(t, inCart, p.unit) })}</span>}
                  </p>
                  <SaleQuantity value={inCart} product={p} name={n.primary} onChange={(v) => setQty(p.id, v)} onPicker={loose ? () => setPicker({ id: p.id, mode: line?.amount !== undefined ? "amount" : "weight" }) : undefined} />
                </div>
              ) : (
                <span className="flex flex-col items-stretch gap-1">
                  <button type="button" onClick={() => addOne(p)} className="num min-h-[56px] min-w-[84px] rounded-xl bg-paper-2 px-3 text-xl font-bold" data-testid={`sale-add-${p.id}`}>
                    <span className="block text-sm">+ {t("common.add")}</span>
                    {formatINR(p.sellPrice)}
                    {loose && <span className="block text-xs font-semibold text-ink-soft">/ {t(`unit.${p.unit}`)}</span>}
                  </button>
                  {loose && (
                    <button type="button" onClick={() => setPicker({ id: p.id, mode: "amount" })} className="min-h-12 rounded-xl border-2 border-teal px-2 text-sm font-bold text-teal" data-testid={`sale-amt-${p.id}`}>
                      {ts("byAmountBtn")}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
        {products && shownProducts.length === 0 && (
          <li className="py-8 text-center text-lg text-ink-soft">
            {selectedOnly ? ts("noneSelected") : query.trim() ? t("voice.noMatch", { text: query.trim() }) : ts("empty")}
            {suggestions.length > 0 && (
              <span className="mt-3 block">
                <span className="block text-sm">{t("voice.closest")}</span>
                <span className="mt-2 flex flex-wrap justify-center gap-2">
                  {suggestions.map((p) => (
                    <button key={p.id} type="button" className="min-h-12 rounded-full bg-paper-2 px-4 font-semibold text-ink" onClick={() => pickProduct(p.id)}>
                      {names(p, locale).primary}
                    </button>
                  ))}
                </span>
              </span>
            )}
            {query.trim() && (
              <Link href={`/stock?add=${encodeURIComponent(query.trim())}`} className="mt-3 inline-block min-h-12 content-center font-semibold text-teal underline">
                {t("voice.addProduct", { text: query.trim() })}
              </Link>
            )}
          </li>
        )}
      </ul>

      {/* Cart bar */}
      {count > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-30 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] lg:sticky lg:bottom-6 lg:mt-6 lg:px-0">
          <button
            type="button"
            onClick={() => setCheckout(true)}
            className="mx-auto flex min-h-[68px] w-full max-w-[568px] flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[1.4rem] bg-teal px-5 py-2 text-paper shadow-[0_12px_30px_-12px_rgba(9,62,65,0.8)]"
          >
            <span className="min-w-0 text-left">
              <span className="block text-sm font-semibold opacity-90">{ts("items", { count })}</span>
              <span className="num block font-brand text-3xl leading-none font-bold [overflow-wrap:anywhere]">{formatINR(total)}</span>
            </span>
            <span className="rounded-xl bg-mustard px-4 py-2.5 text-lg font-extrabold text-ink">{ts("next")} →</span>
          </button>
        </div>
      )}

      {/* Checkout */}
      <Sheet
        open={checkout}
        onClose={() => { if (!busy) setCheckout(false); }}
        title={ts("bill")}
        footer={
          <div>
            {checkoutIssue ? (
              <p role="status" className="mb-2 text-center font-semibold text-brick">{checkoutIssue}</p>
            ) : count > 0 && (
              <p className="num mb-2 text-center font-semibold text-ink-soft">
                {PAY_METHODS.filter((m) => plan.amounts[m] > 0).map((m) => m === "upi" && upi?.state === "pending"
                  ? t("pay.pendingBadge", { amount: formatINR(plan.amounts[m]) })
                  : `${ts(m)} ${formatINR(plan.amounts[m])}`).join(" + ")}
              </p>
            )}
            <button type="button" className="btn btn-primary min-h-[64px] w-full text-xl" onClick={confirm} disabled={busy || !count || missingProducts || discountInvalid || !!invalidItem}>
              {busy ? t("common.saving") : ts("confirm", { amount: formatINR(total) })}
            </button>
          </div>
        }
      >
        {failed && <p role="alert" className="mb-3 font-semibold text-brick">{t("common.saveFailed")}</p>}
        <fieldset disabled={busy} className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-bold">{ts("reviewItems")}</h3>
          <button type="button" className="min-h-12 font-bold text-teal" onClick={() => { setCheckout(false); setSelectedOnly(false); setQuery(""); }}>
            + {ts("addMore")}
          </button>
        </div>
        {!count && <p role="status" className="py-4 text-ink-soft">{ts("noneSelected")}</p>}
        <ul className="ruled">
          {lines.map(({ product: p, qty, amount, itemDiscount, discountInvalid: itemInvalid, net }) => (
            <li key={p.id} className="space-y-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-lg font-bold">{names(p, locale).primary}</p>
                <p className="num text-ink-soft">
                  {amount !== undefined ? (
                    <span data-testid="checkout-amount-line">{ts("byAmountLine", { amount: formatINR(amount), qty: fmtQty(t, qty, p.unit) })} = <b className="text-ink">{formatINR(amount)}</b></span>
                  ) : (
                    <>{formatINR(p.sellPrice)} / {t(`unit.${p.unit}`)} × {fmtQty(t, qty, p.unit)} = <b className="text-ink">{formatINR(round2(qty * p.sellPrice))}</b></>
                  )}
                  {qty > Math.max(0, p.qty) && <span className="ml-2 font-semibold text-mustard-ink">{ts("overStock")}</span>}
                  {repeat && repeat.prices[p.id] !== undefined && Math.abs(repeat.prices[p.id] - p.sellPrice) > 0.005 && (
                    <span className="ml-2 font-semibold text-mustard-ink" data-testid="line-price-changed">{ts("wasPrice", { old: formatINR(repeat.prices[p.id]) })}</span>
                  )}
                </p>
              </div>
              <SaleQuantity value={qty} product={p} name={names(p, locale).primary} onChange={(v) => setQty(p.id, v)} onPicker={kindOf(p) === "loose" ? () => setPicker({ id: p.id, mode: amount !== undefined ? "amount" : "weight" }) : undefined} />
              <ItemDiscount name={names(p, locale).primary} value={draft.itemDiscounts?.[p.id]} amount={itemDiscount} net={net} invalid={itemInvalid} onChange={(value) => setItemDiscount(p.id, value)} />
            </li>
          ))}
        </ul>
        {overLines.length > 0 && (
          <div role="status" className="mt-2 rounded-2xl border-2 border-mustard bg-mustard-soft/60 px-4 py-3" data-testid="short-warning">
            <p className="font-bold">{ts("shortWarnTitle")}</p>
            <ul className="mt-1 text-sm">
              {overLines.map(({ product: p, qty }) => (
                <li key={p.id} className="num">
                  {ts("shortWarnLine", { name: names(p, locale).primary, have: `${formatNum(p.qty)} ${t(`unit.${p.unit}`)}`, sell: `${formatNum(qty)} ${t(`unit.${p.unit}`)}` })}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-sm text-ink-soft">{ts("shortWarnHint")}</p>
          </div>
        )}
        <section className="mt-3 rounded-2xl border border-line bg-card p-3" aria-label={t("discount.title")}>
          {!draft.discount ? <button type="button" className="btn btn-ghost w-full" onClick={() => update((d) => ({ ...d, discount: { kind: "amount", value: "" } }))}>{t("discount.add")}</button> : <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-bold">{t("discount.title")}</h3>
              <button type="button" className="min-h-12 px-2 font-bold text-brick" onClick={() => update((d) => ({ ...d, discount: null }))}>{t("discount.remove")}</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="label min-w-0">{t("discount.type")}
                <select className="input mt-1" value={draft.discount.kind} onChange={(e) => update((d) => ({ ...d, discount: { kind: e.target.value as "amount" | "percent", value: "" } }))}>
                  <option value="amount">{t("discount.rupees")}</option><option value="percent">{t("discount.percent")}</option>
                </select>
              </label>
              <label className="label min-w-0">{t(draft.discount.kind === "percent" ? "discount.percentValue" : "discount.amountValue")}
                <input className="input num mt-1" inputMode="decimal" value={draft.discount.value} placeholder="0" aria-invalid={discountInvalid}
                  onChange={(e) => { const value = e.target.value; update((d) => ({ ...d, discount: { kind: d.discount?.kind ?? "amount", value } })); }} />
              </label>
            </div>
            <p className="mt-2 text-sm text-ink-soft">{t("discount.hint")}</p>
            {discountInvalid && <p role="alert" className="mt-2 font-semibold text-brick">{t("discount.invalid")}</p>}
          </>}
          {(discount > 0 || itemDiscounts > 0) && <dl className="num mt-3 space-y-1">
            <div className="flex flex-wrap justify-between gap-2"><dt>{t("discount.subtotal")}</dt><dd>{formatINR(subtotal)}</dd></div>
            {itemDiscounts > 0 && <div className="flex flex-wrap justify-between gap-2"><dt>{t("discount.itemsTotal")}</dt><dd>−{formatINR(itemDiscounts)}</dd></div>}
            {discount > 0 && <div className="flex flex-wrap justify-between gap-2"><dt>{t("discount.title")}</dt><dd>−{formatINR(discount)}</dd></div>}
          </dl>}
        </section>
        <label className="mt-3 flex min-h-12 items-center gap-3 rounded-xl border border-line bg-card px-3 py-2 font-bold">
          <input type="checkbox" className="h-5 w-5 accent-teal" checked={!!draft.roundToRupee} onChange={(e) => update((d) => ({ ...d, roundToRupee: e.target.checked }))} />
          <span className="flex-1">{t("rounding.title")}</span>
          <span className="num">{rounding === 0 ? "" : `${rounding > 0 ? "+" : "−"}${formatINR(Math.abs(rounding))}`}</span>
        </label>
        {draft.roundToRupee && <p className="mt-1 text-sm text-ink-soft">{t("rounding.hint")}</p>}
        <div className="mt-2 flex flex-wrap items-baseline justify-between border-t-2 border-ink/80 pt-3">
          <span className="text-lg font-bold">{ts("total")}</span>
          <span className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] [overflow-wrap:anywhere] font-bold">{formatINR(total)}</span>
        </div>

        <PaymentPanel
          shop={shop}
          total={total}
          payment={payment}
          split={split}
          onPayment={setPayment}
          onSplit={setSplit}
          tendered={tendered}
          onTendered={setTendered}
          upi={upi}
          onUpi={setUpi}
          upiRef={upiRef}
          onUpiRef={setUpiRef}
        />

        {!showCustomer && (
          <button type="button" className="mt-4 min-h-[48px] font-bold text-teal" onClick={() => setCustOpen(true)} data-testid="sale-add-customer">
            + {ts("addCustomerOptional")}
          </button>
        )}
        {showCustomer && (
          <div className="mt-4 space-y-3 rounded-2xl bg-paper-2/70 p-4">
            <label className="label" htmlFor="cust">
              {needsCustomer ? ts("customer") : ts("customerOptional")}
            </label>
            {!newCust ? (
              <>
                <select id="cust" className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">{ts("pickCustomer")}</option>
                  {(customers ?? [])
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.balance > 0 ? `(${formatINR(c.balance)})` : ""}
                      </option>
                    ))}
                </select>
                <button type="button" className="min-h-[48px] font-bold text-teal" onClick={() => setNewCust({ name: "", phone: "" })}>
                  {ts("newCustomer")}
                </button>
              </>
            ) : (
              <>
                <input className="input" aria-label={ts("customerName")} placeholder={ts("customerName")} value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} />
                <input className="input num" inputMode="tel" aria-label={ts("customerPhone")} placeholder={ts("customerPhone")} value={newCust.phone} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} />
                <button type="button" className="min-h-[48px] font-semibold text-ink-soft" onClick={() => setNewCust(null)}>
                  ← {ts("pickCustomer")}
                </button>
              </>
            )}
          </div>
        )}
        <button type="button" className="mt-4 min-h-[48px] min-w-12 px-2 font-semibold text-brick" onClick={() => {
          if (!window.confirm(ts("clearConfirm"))) return;
          update(() => emptySaleDraft(shop.id)); setCheckout(false); setCustOpen(false);
        }}>
          {ts("clear")}
        </button>
        </fieldset>
      </Sheet>

      {/* Success */}
      {done && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-teal-deep/70 p-5">
          <div className="fade-in max-h-[90dvh] w-full max-w-[420px] overflow-y-auto rounded-[1.75rem] bg-paper p-6 text-center shadow-2xl" style={{ backgroundImage: "var(--grain)" }}>
            <SaleStamp label={ts("success")} />
            <p className="num mt-4 font-brand text-[clamp(2rem,11vw,3rem)] [overflow-wrap:anywhere] font-bold">{formatINR(done.total)}</p>
            <p className="mt-1 text-lg text-ink-soft">
              {paymentsOf(done).map((p) => `${ts(p.method)} ${formatINR(p.amount)}${p.status === "pending" ? " ⏳" : ""}`).join(" + ")}
              {doneCustomer && <> · {doneCustomer.name}</>}
            </p>
            {paymentsOf(done).map((p) =>
              p.method === "cash" && (p.change ?? 0) > 0 ? (
                <p key="chg" data-testid="done-change" className="num mt-3 rounded-2xl bg-mustard px-4 py-3 font-brand text-[clamp(1.75rem,9vw,2.25rem)] font-bold [overflow-wrap:anywhere]">
                  {t("pay.change", { amount: formatINR(p.change ?? 0) })}
                </p>
              ) : null,
            )}
            {paymentsOf(done).some((p) => p.status === "pending") && <p className="mt-2 font-semibold text-mustard-ink">{t("pay.upiPendingNote")}</p>}
            <button type="button" className="btn btn-primary mt-6 w-full min-h-[60px] text-lg" onClick={() => setDone(null)} autoFocus>
              {ts("newSale")} →
            </button>
            <a href={waLink(billText(t, done, shop, locale), doneCustomer?.phone)} target="_blank" rel="noreferrer" className="btn btn-wa mt-3 w-full min-h-[60px] text-lg">
              <IconWhatsApp /> {ts("shareBill")}
            </a>
            <ReceiptPrint sale={done} shop={shop} customer={doneCustomer} />
          </div>
        </div>
      )}

      {picker && byId.get(picker.id) && (() => {
        const p = byId.get(picker.id)!;
        const cur = lines.find((l) => l.product.id === p.id);
        return (
          <WeightPicker
            key={`${picker.id}-${picker.mode}`}
            product={p}
            name={names(p, locale).primary}
            initialMode={picker.mode}
            current={cur ? { qty: cur.qty, amount: cur.amount } : undefined}
            onWeight={(q) => {
              setQty(p.id, q);
              setPicker(null);
              setQuery("");
            }}
            onAmount={(a, q) => {
              setAmount(p.id, a, q);
              setPicker(null);
              setQuery("");
            }}
            onRemove={cur ? () => { setQty(p.id, 0); setPicker(null); } : undefined}
            onClose={() => setPicker(null)}
          />
        );
      })()}
      <BarcodeScanner open={scan} onClose={() => setScan(false)} onDetected={onScan} />
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}
