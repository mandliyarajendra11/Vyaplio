"use client";

import { useTranslations } from "next-intl";
import type { Sale } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { paymentsOf } from "@/lib/payments";

export const PAY_STYLE = { cash: "bg-leaf/15 text-leaf", upi: "bg-teal/15 text-teal", credit: "bg-brick/15 text-brick" } as const;

/** One chip per payment part; a single-method bill shows one chip without the amount. */
export function PaymentBadges({ sale, customerName }: { sale: Sale; customerName?: string }) {
  const t = useTranslations();
  const parts = paymentsOf(sale).filter((p) => p.amount > 0 || paymentsOf(sale).length === 1);
  const single = parts.length === 1;
  return (
    <>
      {parts.map((p, i) => {
        const pending = p.method === "upi" && p.status === "pending";
        return (
          <span
            key={i}
            data-testid={pending ? "upi-pending-badge" : undefined}
            className={`num rounded-full px-3 py-0.5 text-sm font-bold ${pending ? "bg-mustard text-ink" : PAY_STYLE[p.method]}`}
          >
            {pending ? t("pay.pendingBadge", { amount: formatINR(p.amount) }) : single ? t(`sale.${p.method}`) : `${t(`sale.${p.method}`)} ${formatINR(p.amount)}`}
            {p.method === "credit" && customerName && ` · ${customerName}`}
          </span>
        );
      })}
    </>
  );
}
