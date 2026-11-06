"use client";

import { useLocale, useTranslations } from "next-intl";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { fmtDate } from "@/lib/dates";
import { ADJUST_REASONS, db, type AdjustReason, type Locale, type Product } from "@/lib/db";
import { useStockMoves } from "@/lib/hooks";
import { formatNum, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { recordStockAdjustment } from "@/lib/ops";
import { parseQuantity } from "@/lib/quantity";
import { Sheet } from "./Sheet";

const signed = (n: number) => (n > 0 ? `+${formatNum(n)}` : n < 0 ? `−${formatNum(-n)}` : "0");

/**
 * "Stock count / correction": a reasoned change recorded as a stock move (count, damage, theft,
 * purchase not entered). Never overwrites the stock number directly.
 */
export function StockAdjustSheet({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved?: (msg: string) => void }) {
  const t = useTranslations();
  const ta = useTranslations("adjust");
  const locale = useLocale() as Locale;
  // Live: a sale on this phone or a pulled change while the sheet is open updates the numbers.
  const live = useLiveQuery(() => db.products.get(product.id), [product.id]) ?? product;
  const moves = useStockMoves(product.id);
  const [reason, setReason] = useState<AdjustReason>("count");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unit = t(`unit.${live.unit}`);

  const trimmed = text.trim();
  const qty = reason === "count" && /^[0०]+(?:[.][0०]{1,2})?$/.test(trimmed) ? 0 : parseQuantity(trimmed, live.unit);
  const to = qty === null ? null : reason === "count" ? qty : reason === "purchase" ? round2(live.qty + qty) : round2(live.qty - qty);

  const save = async () => {
    if (qty === null) {
      setError(ta("invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await recordStockAdjustment({ productId: live.id, reason, qty, note });
      onSaved?.(ta("saved"));
      onClose();
    } catch {
      setError(ta("failed"));
    } finally {
      setBusy(false);
    }
  };

  const qtyLabel = reason === "count" ? ta("qtyCount", { unit }) : reason === "purchase" ? ta("qtyIn", { unit }) : ta("qtyOut", { unit });

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("stock.adjustFor", { name: names(live, locale).primary })}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || qty === null} onClick={save} data-testid="adjust-save">
          {busy ? t("common.saving") : ta("save")}
        </button>
      }
    >
      <div className="space-y-4" data-testid="adjust-sheet">
        <p className={`num text-xl font-bold ${live.qty < 0 ? "text-brick" : ""}`}>{t("stock.current", { qty: `${formatNum(live.qty)} ${unit}` })}</p>
        {live.qty < 0 && <p className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{ta("negative", { qty: `${formatNum(-live.qty)} ${unit}` })}</p>}
        <p className="text-ink-soft">{ta("intro")}</p>
        <fieldset>
          <legend className="label">{ta("what")}</legend>
          <div className="grid gap-2" role="radiogroup">
            {ADJUST_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={reason === r}
                onClick={() => setReason(r)}
                className={`min-h-[52px] rounded-2xl border-2 px-4 text-left font-bold ${reason === r ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
              >
                {ta(`reason.${r}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor="adj-qty">
            {qtyLabel}
          </label>
          <input id="adj-qty" className="input num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          {to !== null && (
            <p className="num mt-2 text-lg font-semibold" data-testid="adjust-preview">
              {ta("preview", { from: formatNum(live.qty), to: formatNum(to), unit })}
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="adj-note">
            {ta("note")}
          </label>
          <input id="adj-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
            {error}
          </p>
        )}
        <section>
          <h3 className="label">{ta("history")}</h3>
          {moves && moves.length === 0 && <p className="text-ink-soft">{ta("noHistory")}</p>}
          <ul className="ruled" data-testid="adjust-history">
            {(moves ?? []).map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-semibold">{ta(`move.${m.reason}`)}</p>
                  <p className="text-sm text-ink-soft">
                    {fmtDate(m.createdAt, locale, "d MMM, h:mm a")}
                    {m.counted !== undefined && <> · {ta("counted", { qty: formatNum(m.counted) })}</>}
                    {m.note && <> · {m.note}</>}
                  </p>
                  {!!m.shortBy && <p className="text-sm font-bold text-brick">{ta("shortBy", { qty: `${formatNum(m.shortBy)} ${unit}` })}</p>}
                </div>
                <span className={`num shrink-0 font-extrabold ${m.delta < 0 ? "text-brick" : "text-leaf"}`}>{signed(m.delta)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Sheet>
  );
}
