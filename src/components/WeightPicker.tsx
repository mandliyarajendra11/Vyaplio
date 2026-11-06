"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Product } from "@/lib/db";
import { formatINR, parseMoney, round2 } from "@/lib/money";
import { AMOUNT_PRESETS, LOOSE_PRESETS, fmtQty, parseLooseInput, qtyForAmount, validAmount } from "@/lib/units";
import { Sheet } from "./Sheet";

export type PickMode = "weight" | "amount";

/**
 * Loose goods at the counter: pick a weight / volume (100 g · 250 g · 500 g · 1 kg or type g / kg) or
 * sell by amount ("₹20 का सामान": ₹10 · 20 · 50 · 100 or type ₹; the weight is worked out and shown big).
 * Mount it keyed by product so it starts fresh for each item.
 */
export function WeightPicker({
  product,
  name,
  initialMode = "weight",
  current,
  onWeight,
  onAmount,
  onRemove,
  onClose,
}: {
  product: Product;
  name: string;
  initialMode?: PickMode;
  /** What is on the bill now (qty, and ₹ when sold by amount). */
  current?: { qty: number; amount?: number };
  onWeight: (qty: number) => void;
  onAmount: (amount: number, qty: number) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const tp = useTranslations("picker");
  const kg = product.unit === "kg";
  const [mode, setMode] = useState<PickMode>(initialMode);
  const [small, setSmall] = useState(true);
  const [weight, setWeight] = useState("");
  const [amount, setAmount] = useState(current?.amount !== undefined ? String(current.amount) : "");
  const unit = t(`unit.${product.unit}`);
  const smallUnit = tp(kg ? "g" : "ml");
  const typedQty = weight.trim() ? parseLooseInput(weight, small) : null;
  const amt = amount.trim() ? parseMoney(amount) : null;
  const amtQty = amt !== null && validAmount(amt) ? qtyForAmount(amt, product) : null;
  const noPrice = !(product.sellPrice > 0);

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="block min-w-0">
          <span className="block break-words">{name}</span>
          <span className="num block text-base font-semibold text-ink-soft">{tp("rate", { price: formatINR(product.sellPrice), unit })}</span>
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label={tp("how")}>
        {(["weight", "amount"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            data-testid={`wp-tab-${m}`}
            className={`min-h-14 rounded-2xl border-2 px-2 text-lg font-bold ${mode === m ? "border-teal bg-teal text-paper" : "border-line bg-card text-ink"}`}
          >
            {tp(m === "weight" ? (kg ? "tabWeight" : "tabVolume") : "tabAmount")}
          </button>
        ))}
      </div>

      {mode === "weight" ? (
        <div className="mt-4 space-y-4" role="tabpanel">
          <div className="grid grid-cols-2 gap-2">
            {LOOSE_PRESETS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onWeight(q)}
                data-testid={`wp-preset-${Math.round(q * 1000)}`}
                className={`flex min-h-16 flex-col items-center justify-center rounded-2xl border-2 px-2 ${current && current.amount === undefined && Math.abs(current.qty - q) < 1e-9 ? "border-teal bg-teal/10" : "border-line bg-paper-2"}`}
              >
                <span className="text-xl font-extrabold">{fmtQty(t, q, product.unit)}</span>
                <span className="num text-sm text-ink-soft">{formatINR(round2(q * product.sellPrice))}</span>
              </button>
            ))}
          </div>
          <div>
            <label className="label" htmlFor="wp-weight">{tp("typeWeight")}</label>
            <div className="flex flex-wrap gap-2">
              <input
                id="wp-weight"
                className="input num min-w-0 flex-1 text-2xl"
                inputMode="decimal"
                autoComplete="off"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                aria-invalid={!!weight.trim() && typedQty === null}
                data-testid="wp-weight"
              />
              <div className="inline-flex rounded-2xl border-2 border-line p-1" role="group" aria-label={tp("unitChoice")}>
                {[true, false].map((s) => (
                  <button
                    key={String(s)}
                    type="button"
                    aria-pressed={small === s}
                    onClick={() => setSmall(s)}
                    data-testid={`wp-unit-${s ? "small" : "big"}`}
                    className={`min-h-12 min-w-12 rounded-xl px-2 font-bold ${small === s ? "bg-teal text-paper" : "text-ink"}`}
                  >
                    {s ? smallUnit : unit}
                  </button>
                ))}
              </div>
            </div>
            {weight.trim() && typedQty === null && <p role="alert" className="mt-2 font-semibold text-brick">{tp("badWeight", { min: smallUnit })}</p>}
            {typedQty !== null && (
              <p className="num mt-2 text-lg font-bold">
                {fmtQty(t, typedQty, product.unit)} = {formatINR(round2(typedQty * product.sellPrice))}
              </p>
            )}
            <button type="button" className="btn btn-primary mt-3 min-h-14 w-full text-lg" disabled={typedQty === null} onClick={() => typedQty !== null && onWeight(typedQty)} data-testid="wp-weight-add">
              {tp("add")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4" role="tabpanel">
          {noPrice ? (
            <p role="alert" className="font-semibold text-brick">{tp("noPrice")}</p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                {AMOUNT_PRESETS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmount(String(a))}
                    aria-pressed={amt === a}
                    data-testid={`wp-amt-${a}`}
                    className={`num min-h-14 rounded-2xl border-2 px-1 text-lg font-extrabold ${amt === a ? "border-teal bg-teal text-paper" : "border-line bg-paper-2 text-ink"}`}
                  >
                    ₹{a}
                  </button>
                ))}
              </div>
              <div>
                <label className="label" htmlFor="wp-amount">{tp("typeAmount")}</label>
                <input
                  id="wp-amount"
                  className="input num text-2xl"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={!!amount.trim() && amtQty === null}
                  data-testid="wp-amount"
                />
              </div>
              <div aria-live="polite" className="rounded-2xl bg-mustard-soft/70 px-4 py-4 text-center" data-testid="wp-result">
                {amtQty !== null && amt !== null ? (
                  <>
                    <p className="num font-brand text-[clamp(2rem,11vw,2.75rem)] leading-tight font-bold [overflow-wrap:anywhere]">
                      {tp("result", { amount: formatINR(amt), qty: fmtQty(t, amtQty, product.unit) })}
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">{tp("rounding", { min: smallUnit })}</p>
                  </>
                ) : amount.trim() ? (
                  <p role="alert" className="font-semibold text-brick">{amt !== null && validAmount(amt) ? tp("tooSmall", { min: smallUnit }) : tp("badAmount")}</p>
                ) : (
                  <p className="text-ink-soft">{tp("amountHint")}</p>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary min-h-14 w-full text-lg"
                disabled={amtQty === null || amt === null}
                onClick={() => amt !== null && amtQty !== null && onAmount(round2(amt), amtQty)}
                data-testid="wp-amount-add"
              >
                {tp("add")}
              </button>
            </>
          )}
        </div>
      )}
      {onRemove && (
        <button type="button" className="mt-4 min-h-12 px-2 font-semibold text-brick" onClick={onRemove} data-testid="wp-remove">
          {tp("remove")}
        </button>
      )}
    </Sheet>
  );
}
