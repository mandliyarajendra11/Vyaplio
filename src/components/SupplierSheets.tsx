"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { v4 as uuid } from "uuid";
import { useActor } from "@/lib/actor";
import type { Locale, Product, Shop, Supplier } from "@/lib/db";
import { formatINR, formatNum, parseMoney, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { parseQuantity } from "@/lib/quantity";
import { adjustSupplier, paySupplier, returnToSupplier, saveSupplier, SupplierError, type DueState, type SupplierStatus } from "@/lib/suppliers";
import { Sheet } from "./Sheet";

type T = ReturnType<typeof useTranslations>;

/** Error message for a failed supplier-diary write. `t` = root translator. */
export function supplierErrText(t: T, e: unknown) {
  return e instanceof SupplierError ? t(`suppliers.err_${e.code}`) : t("common.saveFailed");
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
      {text}
    </p>
  );
}

/* ------------------------------ add / edit supplier ------------------------------ */

export function SupplierFormSheet({ shopId, supplier, onClose, onSaved }: { shopId: string; supplier?: Supplier; onClose: () => void; onSaved: (s: Supplier) => void }) {
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const [name, setName] = useState(supplier?.name ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [items, setItems] = useState(supplier?.items ?? "");
  const [terms, setTerms] = useState(supplier?.termsDays === undefined ? "" : String(supplier.termsDays));
  const [notes, setNotes] = useState(supplier?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const n = parseMoney(terms);
    const termsDays = terms.trim() === "" ? null : n;
    if (termsDays !== null && (n === null || !Number.isInteger(n))) return setError(ts("err_terms"));
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveSupplier(shopId, { name, phone, items, termsDays, notes }, supplier?.id));
    } catch (e) {
      setError(supplierErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={supplier ? ts("editTitle") : ts("addTitle")}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || !name.trim()} onClick={save} data-testid="supplier-save">
          {busy ? t("common.saving") : t("common.save")}
        </button>
      }
    >
      <div className="space-y-4" data-testid="supplier-form">
        <div>
          <label className="label" htmlFor="sup-name">
            {ts("name")}
          </label>
          <input id="sup-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
        </div>
        <div>
          <label className="label" htmlFor="sup-phone">
            {ts("phone")}
          </label>
          <input id="sup-phone" className="input num" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" maxLength={15} />
          <p className="mt-1 text-sm text-ink-soft">{ts("phoneHint")}</p>
        </div>
        <div>
          <label className="label" htmlFor="sup-items">
            {ts("items")}
          </label>
          <input id="sup-items" className="input" value={items} onChange={(e) => setItems(e.target.value)} placeholder={ts("itemsPh")} maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="sup-terms">
            {ts("terms")}
          </label>
          <input id="sup-terms" className="input num" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={3} />
          <p className="mt-1 text-sm text-ink-soft">{ts("termsHint")}</p>
        </div>
        <div>
          <label className="label" htmlFor="sup-notes">
            {ts("notes")}
          </label>
          <textarea id="sup-notes" className="input min-h-[96px] py-3" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </div>
        <ErrorLine text={error} />
      </div>
    </Sheet>
  );
}

/* ------------------------------ pay supplier ------------------------------ */

export function PaySupplierSheet({ shop, supplier, status, onClose, onDone }: { shop: Shop; supplier: Supplier; status: SupplierStatus; onClose: () => void; onDone: (msg: string) => void }) {
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const actor = useActor(shop);
  const [id] = useState(() => uuid());
  const owed = Math.max(0, status.outstanding);
  const [text, setText] = useState(owed > 0 ? String(owed) : "");
  const [method, setMethod] = useState<"cash" | "upi">("cash");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = parseMoney(text);
  const valid = amount !== null && amount > 0;

  const save = async () => {
    if (!valid) return setError(ts("err_amount"));
    setBusy(true);
    setError(null);
    try {
      await paySupplier({ id, shopId: shop.id, supplierId: supplier.id, amount: amount!, method, note, byName: actor.name, closedReason: ts("closedReason") });
      onDone(method === "cash" ? ts("paidCash", { amount: formatINR(amount!) }) : ts("paidUpi", { amount: formatINR(amount!) }));
      onClose();
    } catch (e) {
      setError(supplierErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={ts("payTitle", { name: supplier.name })}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || !valid} onClick={save} data-testid="pay-save">
          {busy ? t("common.saving") : valid ? ts("payBtn", { amount: formatINR(amount!) }) : ts("payBtnEmpty")}
        </button>
      }
    >
      <div className="space-y-4" data-testid="pay-sheet">
        <p className="num text-xl font-bold">{owed > 0 ? ts("owe", { amount: formatINR(owed) }) : ts("settled")}</p>
        <div>
          <label className="label" htmlFor="pay-amt">
            {ts("payAmount")}
          </label>
          <input id="pay-amt" className="input num text-xl" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          {valid && amount! > owed + 0.005 && <p className="mt-1 font-semibold text-mustard-ink">{ts("payMore", { amount: formatINR(round2(amount! - owed)) })}</p>}
        </div>
        <fieldset>
          <legend className="label">{ts("payHow")}</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(["cash", "upi"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => setMethod(m)}
                data-testid={`pay-${m}`}
                className={`min-h-[52px] rounded-2xl border-2 px-3 font-bold ${method === m ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
              >
                {t(`sale.${m}`)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-ink-soft">{method === "cash" ? ts("payCashHint") : ts("payUpiHint")}</p>
        </fieldset>
        <div>
          <label className="label" htmlFor="pay-note">
            {ts("note")}
          </label>
          <input id="pay-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </div>
        <ErrorLine text={error} />
      </div>
    </Sheet>
  );
}

/* ------------------------------ return to supplier / debit note ------------------------------ */

export function ReturnSheet({ shop, supplier, products, onClose, onDone }: { shop: Shop; supplier: Supplier; products: Product[]; onClose: () => void; onDone: (msg: string) => void }) {
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const locale = useLocale() as Locale;
  const actor = useActor(shop);
  const [id] = useState(() => uuid());
  const [productId, setProductId] = useState("");
  const [qtyText, setQtyText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const product = products.find((p) => p.id === productId);
  const qty = product ? parseQuantity(qtyText, product.unit) : null;
  const typed = parseMoney(amountText);
  const auto = product && qty ? round2(qty * product.buyPrice) : 0;
  const amount = amountText.trim() ? typed : auto;
  const valid = amount !== null && amount > 0 && !!reason.trim() && (!product || qty !== null);

  const save = async () => {
    if (!valid) return setError(!reason.trim() ? ts("err_reason") : ts("err_amount"));
    setBusy(true);
    setError(null);
    try {
      await returnToSupplier({
        id,
        shopId: shop.id,
        supplierId: supplier.id,
        lines: product && qty ? [{ productId: product.id, qty, buyPrice: product.buyPrice }] : [],
        amount: amount!,
        reason,
        byName: actor.name,
      });
      onDone(ts("returnSaved", { amount: formatINR(amount!) }));
      onClose();
    } catch (e) {
      setError(supplierErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={ts("returnTitle")}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || !valid} onClick={save} data-testid="return-save">
          {busy ? t("common.saving") : ts("returnBtn")}
        </button>
      }
    >
      <div className="space-y-4" data-testid="return-sheet">
        <p className="text-ink-soft">{ts("returnHint")}</p>
        <div>
          <label className="label" htmlFor="ret-product">
            {ts("returnProduct")}
          </label>
          <select id="ret-product" className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{ts("returnNoGoods")}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {names(p, locale).primary} ({formatNum(p.qty)} {t(`unit.${p.unit}`)})
              </option>
            ))}
          </select>
        </div>
        {product && (
          <div>
            <label className="label" htmlFor="ret-qty">
              {ts("returnQty", { unit: t(`unit.${product.unit}`) })}
            </label>
            <input id="ret-qty" className="input num" inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} autoComplete="off" />
          </div>
        )}
        <div>
          <label className="label" htmlFor="ret-amt">
            {ts("returnAmount")}
          </label>
          <input id="ret-amt" className="input num" inputMode="decimal" value={amountText} placeholder={auto ? formatNum(auto) : ""} onChange={(e) => setAmountText(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="ret-reason">
            {ts("reason")}
          </label>
          <input id="ret-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={ts("returnReasonPh")} maxLength={200} />
        </div>
        <ErrorLine text={error} />
      </div>
    </Sheet>
  );
}

/* ------------------------------ adjustment ------------------------------ */

export function AdjustSupplierSheet({ shop, supplier, onClose, onDone }: { shop: Shop; supplier: Supplier; onClose: () => void; onDone: (msg: string) => void }) {
  const t = useTranslations();
  const ts = useTranslations("suppliers");
  const actor = useActor(shop);
  const [id] = useState(() => uuid());
  const [dir, setDir] = useState<"more" | "less">("less");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = parseMoney(text);
  const valid = amount !== null && amount > 0 && !!reason.trim();

  const save = async () => {
    if (!valid) return setError(!reason.trim() ? ts("err_reason") : ts("err_amount"));
    setBusy(true);
    setError(null);
    try {
      await adjustSupplier({ id, shopId: shop.id, supplierId: supplier.id, amount: dir === "more" ? amount! : -amount!, reason, byName: actor.name });
      onDone(t("common.saved"));
      onClose();
    } catch (e) {
      setError(supplierErrText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={ts("adjustTitle")}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || !valid} onClick={save} data-testid="sadjust-save">
          {busy ? t("common.saving") : t("common.save")}
        </button>
      }
    >
      <div className="space-y-4" data-testid="sadjust-sheet">
        <p className="text-ink-soft">{ts("adjustHint")}</p>
        <div className="grid gap-2" role="radiogroup">
          {(["less", "more"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={dir === d}
              onClick={() => setDir(d)}
              className={`min-h-[52px] rounded-2xl border-2 px-4 text-left font-bold ${dir === d ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
            >
              {ts(d === "less" ? "adjustLess" : "adjustMore")}
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="sadj-amt">
            {ts("adjustAmount")}
          </label>
          <input id="sadj-amt" className="input num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="sadj-reason">
            {ts("reason")}
          </label>
          <input id="sadj-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={ts("adjustReasonPh")} maxLength={200} />
        </div>
        <ErrorLine text={error} />
      </div>
    </Sheet>
  );
}

/** Overdue / due badge (colour + words, never colour alone). */
export function DueBadge({ state, testId }: { state: DueState; testId?: string }) {
  const ts = useTranslations("suppliers");
  if (state === "none" || state === "later") return null;
  const cls = state === "overdue" ? "bg-brick text-paper" : "bg-mustard-soft text-mustard-ink";
  return (
    <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-extrabold ${cls}`} data-testid={testId}>
      {ts(`badge_${state}`)}
    </span>
  );
}
