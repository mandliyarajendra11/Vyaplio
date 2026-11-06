"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useShop } from "./AppShell";
import { Sheet } from "./Sheet";
import { fmtDate } from "@/lib/dates";
import type { Locale, Sale } from "@/lib/db";
import { useCustomers } from "@/lib/hooks";
import { formatINR } from "@/lib/money";
import { settlePendingUpi } from "@/lib/ops";
import { PaymentError, pendingUpi } from "@/lib/payments";

/** Settle a bill's unconfirmed UPI: money arrived (optional UTR), paid in cash instead, or move it to udhaar. */
export function PendingUpiSheet({ sale, onClose, onDone }: { sale: Sale; onClose: () => void; onDone: (msg: string) => void }) {
  const shop = useShop();
  const t = useTranslations();
  const tp = useTranslations("pay");
  const locale = useLocale() as Locale;
  const customers = useCustomers(shop.id);
  const [ref, setRef] = useState("");
  const [toCredit, setToCredit] = useState(false);
  const [customerId, setCustomerId] = useState(sale.customerId ?? "");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = pendingUpi(sale);

  const settle = async (to: "upi" | "cash" | "credit") => {
    if (busy) return;
    if (to === "credit" && !customerId && !newName.trim()) return setError(tp("errCustomer"));
    setBusy(true);
    setError(null);
    try {
      await settlePendingUpi({
        saleId: sale.id,
        to,
        ref,
        customerId: customerId || undefined,
        newCustomer: !customerId && newName.trim() ? { name: newName } : undefined,
      });
      onDone(tp("settled"));
      onClose();
    } catch (e) {
      setError(e instanceof PaymentError && e.code === "customer" ? tp("errCustomer") : t("common.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={() => !busy && onClose()} title={tp("pendingTitle")}>
      {error && <p role="alert" className="mb-3 rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}
      <p className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] [overflow-wrap:anywhere] font-bold">{formatINR(amount)}</p>
      <p className="text-ink-soft">{fmtDate(sale.createdAt, locale, "d MMM, h:mm a")}</p>
      <fieldset disabled={busy} className="mt-4 min-w-0 space-y-3">
        <input className="input num" aria-label={tp("upiRef")} placeholder={tp("upiRef")} maxLength={40} value={ref} onChange={(e) => setRef(e.target.value)} />
        <button type="button" className="btn w-full min-h-[60px] bg-leaf text-lg text-paper" onClick={() => settle("upi")}>
          {tp("upiGot")}
        </button>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
          <button type="button" className="btn btn-ghost min-h-[56px]" onClick={() => settle("cash")}>
            {tp("toCash")}
          </button>
          <button type="button" className="btn btn-ghost min-h-[56px] border-brick/40 text-brick" onClick={() => (sale.customerId ? settle("credit") : setToCredit(true))}>
            {tp("toCredit")}
          </button>
        </div>
        {toCredit && !sale.customerId && (
          <div className="space-y-2 rounded-2xl bg-paper-2/70 p-3">
            <label className="label" htmlFor="pu-cust">{tp("pickForCredit")}</label>
            <select id="pu-cust" className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{t("sale.pickCustomer")}</option>
              {(customers ?? [])
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            {!customerId && <input className="input" placeholder={t("sale.customerName")} value={newName} onChange={(e) => setNewName(e.target.value)} />}
            <button type="button" className="btn w-full bg-brick text-paper" onClick={() => settle("credit")}>
              {tp("toCredit")}
            </button>
          </div>
        )}
      </fieldset>
    </Sheet>
  );
}
