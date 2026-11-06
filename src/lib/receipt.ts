import type { Customer, Locale, Sale, SaleCorrection, Shop } from "./db";
import { billNo } from "./billno";
import { billDiscountTotal, itemDiscountTotal, roundOffTotal, totalDiscount } from "./discounts";
import { fmtDate } from "./dates";
import { formatINR, round2 } from "./money";
import { names } from "./names";
import { paymentsOf, refundsOf } from "./payments";
import { fmtQty, lineTotal } from "./units";

type T = (key: string, values?: Record<string, string | number>) => string;
export type ReceiptFormat = "a4" | "80mm" | "58mm";
export interface ReceiptInput {
  sale: Sale;
  shop: Shop;
  locale: Locale;
  format: ReceiptFormat;
  customer?: Pick<Customer, "name">;
  corrections?: SaleCorrection[];
}

/** Every dynamic value is text, including names imported from backups or entered by customers. */
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Standalone, offline receipt. Never includes cost, profit, account IDs or tax claims. */
export function receiptHtml(t: T, { sale, shop, locale, format, customer, corrections = [] }: ReceiptInput) {
  const e = escape;
  const row = (label: string, amount: number, strong = false) =>
    `<div class="summary${strong ? " strong" : ""}"><span>${e(label)}</span><span>${e(formatINR(amount))}</span></div>`;
  const returned = sale.returnedTotal ?? 0;
  const discount = totalDiscount(sale.items);
  const itemCut = itemDiscountTotal(sale.items);
  const billCut = billDiscountTotal(sale.items);
  const rounding = roundOffTotal(sale.items);
  const items = sale.items.map((it) => `<tr><td><strong>${e(names(it, locale).primary)}</strong>
    <div>${e(fmtQty(t, it.qty, it.unit))} × ${e(formatINR(it.price))} / ${e(t(`unit.${it.unit}`))}</div>
    ${it.amount !== undefined ? `<div>${e(t("receipt.fixedAmount"))}</div>` : ""}
    ${(it.discount ?? 0) > 0 ? `<div>${e(t("discount.line", { amount: formatINR(it.discount!) }))}</div>` : ""}
    ${(it.returnedQty ?? 0) > 0 ? `<div>${e(t("receipt.returnedQty", { qty: fmtQty(t, it.returnedQty!, it.unit) }))}</div>` : ""}
    </td><td>${e(formatINR(lineTotal(it)))}</td></tr>`).join("");
  const paymentRows = paymentsOf(sale).map((p) => row(
    p.method === "upi" && p.status === "pending" ? t("receipt.pendingUpi") : t(`sale.${p.method}`), p.amount,
  ) + (p.method === "cash" && p.tendered !== undefined
    ? `<p>${e(t("bill.change", { tendered: formatINR(p.tendered), change: formatINR(p.change ?? 0) }))}</p>` : "")).join("");
  const refundKeys = { cash: "refundCash", upi: "refundUpi", credit: "refundCredit", upiPending: "refundPending" } as const;
  const refunds = corrections.length ? `<section><h2>${e(t("receipt.returns"))}</h2>${corrections.map((c) =>
    `<p>${e(fmtDate(c.createdAt, locale, "d MMM yyyy, h:mm a"))}</p>${refundsOf(c).map((r) => row(t(`correction.${refundKeys[r.method]}`), r.amount)).join("")}`,
  ).join("")}</section>` : "";
  const width = format === "58mm" ? "54mm" : format === "80mm" ? "76mm" : "186mm";
  return `<!doctype html><html lang="${locale === "hi" ? "hi" : "en"}"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>${e(shop.name)} — ${e(t("bill.no", { no: billNo(sale) }))}</title>
    <style>
      @page { size: ${format === "a4" ? "A4" : "auto"}; margin: ${format === "a4" ? "12mm" : "2mm"}; }
      * { box-sizing: border-box; } body { margin: 0 auto; padding: 4mm 0; width: 100%; max-width: ${width}; color: #000; background: #fff; font: ${format === "a4" ? "14px" : "12px"}/1.5 Arial, "Nirmala UI", sans-serif; overflow-wrap: anywhere; }
      h1 { font-size: 20px; margin: 0; } h2 { font-size: 14px; margin: 8px 0 4px; } header, footer { text-align: center; } p { margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 12px; } th, td { padding: 6px 0; text-align: left; vertical-align: top; border-bottom: 1px solid #bbb; }
      th:last-child, td:last-child { text-align: right; width: 30%; padding-left: 6px; font-variant-numeric: tabular-nums; } thead { display: table-header-group; } tr { break-inside: avoid; }
      section { margin-top: 10px; border-top: 1px solid #000; padding-top: 6px; } .summary { display: flex; gap: 8px; justify-content: space-between; margin: 4px 0; break-inside: avoid; } .summary span:last-child { text-align: right; font-variant-numeric: tabular-nums; } .strong { font-weight: bold; font-size: 16px; } footer { margin-top: 16px; } .status { border: 2px solid #000; padding: 4px; font-weight: bold; }
      @media screen { body { padding: 12px; } }
    </style></head><body><header><h1>${e(shop.name)}</h1>${shop.phone ? `<p>${e(shop.phone)}</p>` : ""}
    <p>${e(t("receipt.title"))} · ${e(t("bill.no", { no: billNo(sale) }))}</p>
    <p>${e(fmtDate(sale.createdAt, locale, "d MMM yyyy, h:mm a"))}</p></header>
    ${customer ? `<p>${e(t("receipt.customer", { name: customer.name }))}</p>` : ""}
    ${sale.status === "cancelled" ? `<p class="status">${e(t("bill.cancelled"))}</p>` : ""}
    <table><thead><tr><th>${e(t("receipt.item"))}</th><th>${e(t("receipt.amount"))}</th></tr></thead><tbody>${items}</tbody></table>
    <section>${discount > 0 ? row(t("discount.subtotal"), round2(sale.total + discount - rounding)) + (itemCut > 0 ? row(t("discount.itemsTotal"), -itemCut) : "") + (billCut > 0 ? row(t("discount.title"), -billCut) : "") + `<p>${e(t("discount.netLines"))}</p>` : ""}${rounding !== 0 ? row(t("rounding.line"), rounding) : ""}${row(t("correction.original"), sale.total)}${returned > 0 ? row(t("correction.returned"), -returned) : ""}${row(t("correction.net"), round2(sale.total - returned), true)}</section>
    <section><h2>${e(t("receipt.payments"))}</h2>${paymentRows}</section>${refunds}
    <footer><p>${e(t("bill.thanks"))}</p><p>${e(t("receipt.notTaxInvoice"))}</p><p>Vyaplio</p></footer></body></html>`;
}
