import type { useTranslations } from "next-intl";
import { billNo } from "./billno";
import { billDiscountTotal, itemDiscountTotal, roundOffTotal, totalDiscount } from "./discounts";
import type { Customer, Locale, Sale, Shop } from "./db";
import { fmtDate } from "./dates";
import { formatINR, formatNum } from "./money";
import { names } from "./names";
import { paymentsOf } from "./payments";
import { lineTotal } from "./units";

type T = ReturnType<typeof useTranslations>;

/** WhatsApp bill text. `t` must be the root translator. */
export function billText(t: T, sale: Sale, shop: Shop, locale: Locale) {
  const lines = sale.items.map((i) =>
    t("bill.line", {
      name: names(i, locale).primary,
      qty: formatNum(i.qty),
      unit: t(`unit.${i.unit}`),
      amount: formatINR(lineTotal(i)),
    }),
  );
  return [
    `🧾 ${shop.name}`,
    `${fmtDate(sale.createdAt, locale, "d MMM yyyy, h:mm a")} · ${t("bill.no", { no: billNo(sale) })}`,
    "",
    ...lines,
    "",
    ...(totalDiscount(sale.items) > 0 ? [
      `${t("discount.subtotal")}: ${formatINR(sale.total + totalDiscount(sale.items) - roundOffTotal(sale.items))}`,
      ...(itemDiscountTotal(sale.items) > 0 ? [`${t("discount.itemsTotal")}: −${formatINR(itemDiscountTotal(sale.items))}`] : []),
      ...(billDiscountTotal(sale.items) > 0 ? [`${t("discount.title")}: −${formatINR(billDiscountTotal(sale.items))}`] : []),
      t("discount.netLines"),
    ] : []),
    ...(roundOffTotal(sale.items) !== 0 ? [`${t("rounding.line")}: ${roundOffTotal(sale.items) > 0 ? "+" : "−"}${formatINR(Math.abs(roundOffTotal(sale.items)))}`] : []),
    t("bill.total", { amount: formatINR(sale.total) }),
    ...((sale.returnedTotal ?? 0) > 0
      ? [
          t("bill.returned", { amount: formatINR(sale.returnedTotal ?? 0) }),
          t("bill.net", { amount: formatINR(sale.total - (sale.returnedTotal ?? 0)) }),
        ]
      : []),
    ...(sale.status === "cancelled" ? [t("bill.cancelled")] : []),
    ...paymentLines(t, sale),
    ...(shop.upiId && paymentsOf(sale).some((p) => p.method !== "cash") ? [t("bill.upi", { upi: shop.upiId })] : []),
    "",
    t("bill.thanks"),
    "— Vyaplio",
  ].join("\n");
}

export function reminderText(t: T, customer: Customer, shop: Shop) {
  return t("udhaar.reminder", {
    name: customer.name,
    shop: shop.name,
    amount: formatINR(customer.balance),
    upi: shop.upiId ? t("udhaar.reminderUpi", { upi: shop.upiId }) : "",
  });
}

/** "Payment: Cash" for one method; "Payment: Cash ₹50 + UPI ₹30 + Credit ₹20" for a split bill. */
function paymentLines(t: T, sale: Sale) {
  const parts = paymentsOf(sale);
  const out =
    parts.length === 1
      ? [t("bill.payment", { method: t(`sale.${parts[0].method}`) })]
      : [t("bill.parts", { parts: parts.map((p) => `${t(`sale.${p.method}`)} ${formatINR(p.amount)}`).join(" + ") })];
  for (const p of parts) {
    if (p.method === "cash" && p.tendered !== undefined && (p.change ?? 0) > 0) {
      out.push(t("bill.change", { tendered: formatINR(p.tendered), change: formatINR(p.change ?? 0) }));
    }
    if (p.method === "upi" && p.status === "pending") out.push(t("bill.pending", { amount: formatINR(p.amount) }));
  }
  return out;
}
