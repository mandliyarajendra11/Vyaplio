"use client";

import { useTranslations } from "next-intl";
import { QrCode } from "./UpiQr";
import type { PaymentType, Shop } from "@/lib/db";
import { formatINR, parseMoney, paymentInput } from "@/lib/money";
import { CASH_NOTES, changeFor, formPlan, isUpiId, PAY_METHODS, startSplit, upiLink, type SplitForm } from "@/lib/payments";

export type UpiChoice = { state: "paid" | "pending"; amount: number } | null;

/**
 * Checkout payment block: one-tap single method (default) or a split across cash / UPI / udhaar,
 * cash tendered with quick notes and a big change display, and the UPI QR with explicit confirmation.
 */
export function PaymentPanel(props: {
  shop: Shop;
  total: number;
  payment: PaymentType;
  split: SplitForm | null;
  onPayment: (p: PaymentType) => void;
  onSplit: (s: SplitForm | null) => void;
  tendered: string;
  onTendered: (v: string) => void;
  upi: UpiChoice;
  onUpi: (c: UpiChoice) => void;
  upiRef: string;
  onUpiRef: (v: string) => void;
  billNote?: string;
}) {
  const { shop, total, payment, split, tendered, upi } = props;
  const ts = useTranslations("sale");
  const tp = useTranslations("pay");
  const plan = formPlan(total, payment, split);
  const { cash, upi: upiAmt } = plan.amounts;
  const tenderedNum = tendered.trim() === "" ? null : parseMoney(tendered);
  const change = tenderedNum !== null && Number.isFinite(tenderedNum) ? changeFor(tenderedNum, cash) : 0;
  const shortBy = tenderedNum !== null && Number.isFinite(tenderedNum) && tenderedNum < cash ? cash - tenderedNum : 0;
  const upiChoice = upi && upi.amount === upiAmt ? upi.state : null;
  const hasUpiId = isUpiId(shop.upiId);
  const link = hasUpiId && upiAmt > 0 ? upiLink(shop.upiId!, shop.name, upiAmt, props.billNote) : "";

  const label = (m: PaymentType) => ts(m);

  return (
    <div>
      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2">
        <p className="label mb-0">{ts("payment")}</p>
        <button
          type="button"
          className="min-h-12 rounded-full border-2 border-line bg-card px-3 text-sm font-bold"
          aria-pressed={!!split}
          onClick={() => props.onSplit(split ? null : startSplit(payment))}
        >
          {split ? tp("single") : tp("split")}
        </button>
      </div>

      {!split ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,5.25rem),1fr))] gap-2" role="radiogroup" aria-label={ts("payment")}>
          {PAY_METHODS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={payment === p}
              onClick={() => props.onPayment(p)}
              className={`min-h-[60px] rounded-2xl border-2 text-lg font-extrabold ${
                payment === p ? (p === "credit" ? "border-brick bg-brick text-paper" : "border-teal bg-teal text-paper") : "border-line bg-card"
              }`}
            >
              {label(p)}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2 rounded-2xl bg-paper-2/70 p-3" data-testid="split">
          <div className="flex flex-wrap gap-2" role="group" aria-label={tp("split")}>
            {PAY_METHODS.map((m) => {
              const on = split[m] !== undefined;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const next = { ...split };
                    if (on) delete next[m];
                    else next[m] = "";
                    props.onSplit(next);
                  }}
                  className={`min-h-12 rounded-full border-2 px-4 font-extrabold ${on ? (m === "credit" ? "border-brick bg-brick text-paper" : "border-teal bg-teal text-paper") : "border-line bg-card"}`}
                >
                  {on ? "✓ " : "+ "}
                  {label(m)}
                </button>
              );
            })}
          </div>
          <p className="text-sm text-ink-soft">{tp("splitHint")}</p>
          {plan.used.map((m) => (
            <label key={m} className="flex items-center gap-3">
              <span className={`w-20 text-lg font-extrabold ${m === "credit" ? "text-brick" : ""}`}>{label(m)}</span>
              <input
                className="input num flex-1 text-xl"
                inputMode="decimal"
                aria-label={`${label(m)} ₹`}
                placeholder={plan.auto === m ? tp("auto", { amount: formatINR(plan.amounts[m]) }) : "0"}
                value={split[m] ?? ""}
                onChange={(e) => props.onSplit({ ...split, [m]: paymentInput(e.target.value) })}
              />
            </label>
          ))}
          <p
            role="status"
            className={`num font-bold ${plan.invalid || Math.abs(plan.left) > 0.005 ? "text-brick" : "text-leaf"}`}
            data-testid="split-status"
          >
            {plan.invalid || plan.left < -0.005
              ? tp("over", { amount: formatINR(-plan.left) })
              : plan.left > 0.005
                ? tp("left", { amount: formatINR(plan.left) })
                : tp("sumOk")}
          </p>
        </div>
      )}

      {cash > 0 && (
        <div className="mt-4 rounded-2xl border-2 border-line bg-card p-3" data-testid="cash-box">
          <label className="label" htmlFor="tendered">
            {tp("tendered")} {split && <span className="num font-normal text-ink-soft">({label("cash")} {formatINR(cash)})</span>}
          </label>
          <p id="tendered-help" className="mb-2 text-sm text-ink-soft">{tp("cashHint")}</p>
          <input
            aria-describedby="tendered-help"
            id="tendered"
            className="input num text-2xl"
            inputMode="decimal"
            placeholder={formatINR(cash)}
            value={tendered}
            onChange={(e) => props.onTendered(paymentInput(e.target.value))}
          />
          <div className="mt-2 flex flex-wrap gap-2" aria-label={tp("tenderedHint")}>
            {CASH_NOTES.map((n) => (
              <button
                key={n}
                type="button"
                className="num min-h-12 min-w-[56px] rounded-xl border-2 border-line bg-paper-2 px-2 font-extrabold"
                onClick={() => props.onTendered(String((parseMoney(tendered) || 0) + n))}
              >
                ₹{n}
              </button>
            ))}
            <button type="button" className="min-h-12 rounded-xl border-2 border-teal px-3 font-extrabold text-teal" onClick={() => props.onTendered(String(cash))}>
              {tp("exact")}
            </button>
            {tendered && (
              <button type="button" className="min-h-12 px-2 font-semibold text-ink-soft" onClick={() => props.onTendered("")}>
                {tp("clearNotes")}
              </button>
            )}
          </div>
          {tenderedNum !== null && (
            <p
              role="status"
              data-testid="change"
              className={`num mt-3 rounded-2xl px-4 py-3 text-center font-brand text-[clamp(1.75rem,9vw,2.25rem)] font-bold [overflow-wrap:anywhere] ${shortBy > 0 ? "bg-brick/10 text-brick" : "bg-mustard text-ink"}`}
            >
              {shortBy > 0 ? tp("short", { amount: formatINR(shortBy) }) : change > 0 ? tp("change", { amount: formatINR(change) }) : tp("noChange")}
            </p>
          )}
        </div>
      )}

      {upiAmt > 0 && (
        <div className="mt-4 rounded-2xl border-2 border-teal/40 bg-card p-3" data-testid="upi-box">
          <p className="num text-xl font-extrabold">{tp("upiTitle", { amount: formatINR(upiAmt) })}</p>
          {hasUpiId ? (
            <div className="mt-2 flex flex-col items-center gap-2">
              <p className="text-sm text-ink-soft">{tp("upiScan")}</p>
              <QrCode text={link} label={`UPI ${shop.upiId} ${formatINR(upiAmt)}`} />
              <p className="num max-w-full text-center text-sm font-semibold break-all">{shop.upiId}</p>
              <a href={link} className="btn btn-ghost min-h-[48px] max-w-full text-center" data-testid="upi-link">
                {tp("upiOpen")}
              </a>
            </div>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">{tp("upiNoId")}</p>
          )}
          <p className="mt-3 text-sm text-ink-soft">{tp("upiCheck")}</p>
          <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2" role="radiogroup" aria-label="UPI">
            <button
              type="button"
              role="radio"
              aria-checked={upiChoice === "paid"}
              onClick={() => props.onUpi({ state: "paid", amount: upiAmt })}
              className={`min-h-[56px] rounded-2xl border-2 font-extrabold ${upiChoice === "paid" ? "border-leaf bg-leaf text-paper" : "border-line bg-card"}`}
            >
              {tp("upiGot")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={upiChoice === "pending"}
              onClick={() => props.onUpi({ state: "pending", amount: upiAmt })}
              className={`min-h-[56px] rounded-2xl border-2 font-extrabold ${upiChoice === "pending" ? "border-mustard-deep bg-mustard text-ink" : "border-line bg-card"}`}
            >
              {tp("upiLater")}
            </button>
          </div>
          {upiChoice === "paid" && (
            <input
              className="input num mt-2"
              aria-label={tp("upiRef")}
              placeholder={tp("upiRef")}
              maxLength={40}
              value={props.upiRef}
              onChange={(e) => props.onUpiRef(e.target.value)}
            />
          )}
          {upiChoice === "pending" && <p className="mt-2 text-sm font-semibold text-mustard-ink">{tp("upiPendingNote")}</p>}
        </div>
      )}
    </div>
  );
}
