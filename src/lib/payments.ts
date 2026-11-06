import type { PayMethod, Sale, SaleCorrection, SalePayment, RefundBucket, RefundPart } from "./db";
import { round2, parseMoney } from "./money";

/**
 * Split payments. A bill is paid by any mix of cash + UPI + udhaar (credit).
 * Old bills (before v5) only have `payment` + `total`; `paymentsOf` reads both shapes so
 * nothing ever has to guess: an old single-method bill is one fully paid part.
 */

export const PAY_METHODS: PayMethod[] = ["cash", "upi", "credit"];
const EPS = 0.005;

export class PaymentError extends Error {
  constructor(
    public code: "sum" | "negative" | "customer" | "tendered" | "upiChoice" | "notPending" | "notFound" | "amount",
  ) {
    super(code);
  }
}

/** The bill's payment parts; legacy rows become a single fully paid part. */
export function paymentsOf(s: Pick<Sale, "payment" | "total" | "payments">): SalePayment[] {
  if (Array.isArray(s.payments) && s.payments.length) return s.payments;
  const method: PayMethod = s.payment === "upi" || s.payment === "credit" ? s.payment : "cash";
  return [{ method, amount: s.total, status: "paid" }];
}

/** Label kind: one method → that method, several → "split". */
export function paymentKind(parts: SalePayment[]): PayMethod | "split" {
  const methods = new Set(parts.filter((p) => p.amount > 0).map((p) => p.method));
  if (methods.size === 1) return [...methods][0];
  return methods.size === 0 ? "cash" : "split";
}

export const partSum = (parts: SalePayment[], method?: PayMethod, status?: "paid" | "pending") =>
  round2(
    parts
      .filter((p) => (!method || p.method === method) && (!status || (p.status ?? "paid") === status))
      .reduce((a, p) => a + p.amount, 0),
  );

/** UPI still waiting for the shopkeeper's "पैसे आ गए". */
export const pendingUpi = (s: Pick<Sale, "payment" | "total" | "payments" | "status">) =>
  (s.status ?? "active") === "cancelled" ? 0 : partSum(paymentsOf(s), "upi", "pending");

/** Change to give back; never negative. */
export const changeFor = (tendered: number, amount: number) => Math.max(0, round2(tendered - amount));

/** Quick notes for the cash-tendered pad. */
export const CASH_NOTES = [10, 20, 50, 100, 200, 500, 2000] as const;

export type SplitInput = Partial<Record<PayMethod, number | undefined>>;

/**
 * Auto-fill the remainder: when exactly one method is left empty, it gets total − (the others).
 * Returns the filled amounts (unchanged when 0 or 2+ fields are empty).
 */
export function autoFill(total: number, input: SplitInput, methods: PayMethod[] = PAY_METHODS): SplitInput {
  const empty = methods.filter((m) => input[m] === undefined || Number.isNaN(input[m]));
  if (empty.length !== 1) return input;
  const used = methods.filter((m) => !empty.includes(m)).reduce((a, m) => a + (input[m] ?? 0), 0);
  return { ...input, [empty[0]]: Math.max(0, round2(total - used)) };
}

export interface PaymentRequest {
  method: PayMethod;
  amount: number;
  /** Cash only: note(s) the customer handed over. */
  tendered?: number;
  /** UPI only: the shopkeeper saw the money arrive ("paid") or will check later ("pending"). */
  upi?: "paid" | "pending";
  ref?: string;
}

/**
 * Validate and normalise the parts for a bill of `total`. Zero parts are dropped,
 * same-method parts merged. Credit needs a customer (checked by the caller who has it).
 */
export function buildPayments(total: number, req: PaymentRequest[], now = Date.now()): SalePayment[] {
  const out: SalePayment[] = [];
  for (const r of req) {
    if (!PAY_METHODS.includes(r.method)) throw new PaymentError("amount");
    if (!Number.isFinite(r.amount) || r.amount < 0) throw new PaymentError("negative");
    const amount = round2(r.amount);
    if (amount <= 0) continue;
    if (out.some((p) => p.method === r.method)) throw new PaymentError("amount");
    const part: SalePayment = { method: r.method, amount, status: "paid" };
    if (r.method === "cash" && r.tendered !== undefined && r.tendered !== null) {
      if (!Number.isFinite(r.tendered) || r.tendered + EPS < amount) throw new PaymentError("tendered");
      part.tendered = round2(r.tendered);
      part.change = changeFor(r.tendered, amount);
    }
    if (r.method === "upi") {
      if (r.upi !== "paid" && r.upi !== "pending") throw new PaymentError("upiChoice");
      part.status = r.upi;
      const ref = r.ref?.trim();
      if (ref) part.ref = ref.slice(0, 40);
      if (r.upi === "paid") part.confirmedAt = now;
    }
    out.push(part);
  }
  if (Math.abs(round2(out.reduce((a, p) => a + p.amount, 0)) - round2(total)) > EPS) throw new PaymentError("sum");
  if (!out.length && total > EPS) throw new PaymentError("sum");
  if (!out.length) out.push({ method: "cash", amount: 0, status: "paid" });
  return out;
}

/** Everything already given back per bucket (legacy corrections = one refund of `amount`). */
export function refundsOf(c: Pick<SaleCorrection, "refunds" | "refundMethod" | "amount">): RefundPart[] {
  if (Array.isArray(c.refunds) && c.refunds.length) return c.refunds;
  return [{ method: c.refundMethod, amount: c.amount }];
}

const refunded = (corrections: SaleCorrection[], m: RefundBucket) =>
  round2(corrections.flatMap(refundsOf).filter((r) => r.method === m).reduce((a, r) => a + r.amount, 0));

/**
 * What can still go back on this bill, per method (each limited to what that method actually brought in):
 *  - credit: the udhaar part not yet reduced (needs the customer);
 *  - cash: the cash part (net of change) minus cash already returned;
 *  - upi: confirmed UPI minus UPI already returned;
 *  - upiPending: unconfirmed UPI – always reduced first, since that money never arrived.
 * Together they cover the bill's net total, so a return / cancel can always be allocated without
 * crossing methods. Crossing (e.g. cash back for a UPI bill) is only done when explicitly asked.
 */
export function refundCaps(sale: Sale, corrections: SaleCorrection[]) {
  const parts = paymentsOf(sale);
  const left = (v: number) => Math.max(0, round2(v));
  return {
    credit: sale.customerId ? left(partSum(parts, "credit") - refunded(corrections, "credit")) : 0,
    cash: left(partSum(parts, "cash") - refunded(corrections, "cash")),
    upi: left(partSum(parts, "upi", "paid") - refunded(corrections, "upi")),
    upiPending: pendingUpi({ ...sale, status: "active" }),
  };
}

/** Methods the bill can refund through without crossing methods (largest first after udhaar). */
export function refundChoices(sale: Sale, corrections: SaleCorrection[]): PayMethod[] {
  const caps = refundCaps(sale, corrections);
  const out: PayMethod[] = [];
  if (caps.credit > EPS) out.push("credit");
  const money = (["cash", "upi"] as const).filter((m) => caps[m] > EPS).sort((a, b) => caps[b] - caps[a]);
  out.push(...money);
  return out;
}

/**
 * Split a refund of `amount`: pending UPI first, then the chosen method up to what it brought in,
 * then udhaar, cash and UPI within their own limits. With `cross`, the chosen cash/UPI route pays
 * everything after pending UPI, even beyond what came in that way (the shopkeeper confirmed a warning).
 */
export function planRefund(sale: Sale, corrections: SaleCorrection[], amount: number, primary: PayMethod, cross = false): RefundPart[] {
  const caps = refundCaps(sale, corrections);
  let left = round2(amount);
  const out: RefundPart[] = [];
  const used: Record<RefundBucket, number> = { cash: 0, upi: 0, credit: 0, upiPending: 0 };
  const take = (method: RefundBucket, cap: number) => {
    const x = round2(Math.min(left, cap - used[method]));
    if (x <= EPS) return;
    const ex = out.find((r) => r.method === method);
    if (ex) ex.amount = round2(ex.amount + x);
    else out.push({ method, amount: x });
    used[method] = round2(used[method] + x);
    left = round2(left - x);
  };
  take("upiPending", caps.upiPending);
  if (cross && primary !== "credit") take(primary, Infinity);
  take(primary, caps[primary]);
  take("credit", caps.credit);
  take("cash", caps.cash);
  take("upi", caps.upi);
  // Only possible after an earlier crossed refund emptied a method: the chosen route (cash for udhaar) pays the rest.
  if (left > EPS) take(primary === "credit" ? "cash" : primary, Infinity);
  return out;
}

/** How much of a refund would cross methods: the part paid by `primary` beyond what it brought in. */
export function crossAmount(sale: Sale, corrections: SaleCorrection[], amount: number, primary: PayMethod) {
  if (primary === "credit") return 0;
  const caps = refundCaps(sale, corrections);
  return Math.max(0, round2(amount - caps.upiPending - caps[primary]));
}

/** Totals per method for a set of bills and corrections (today's money). */
export function moneySplit(sales: Sale[], corrections: SaleCorrection[]) {
  const sum = { cash: 0, upi: 0, credit: 0, upiPending: 0 };
  for (const s of sales) {
    for (const p of paymentsOf(s)) {
      if (p.method === "upi" && (p.status ?? "paid") === "pending") sum.upiPending += p.amount;
      else sum[p.method] += p.amount;
    }
  }
  for (const c of corrections) {
    // Pending-UPI reductions are already reflected in the bill's (current) pending part.
    for (const r of refundsOf(c)) if (r.method !== "upiPending") sum[r.method] -= r.amount;
  }
  return { cash: round2(sum.cash), upi: round2(sum.upi), credit: round2(sum.credit), upiPending: round2(sum.upiPending) };
}

/** `upi://pay` intent for the shop's UPI ID with the exact amount. */
export function upiLink(upiId: string, shopName: string, amount: number, note?: string) {
  const q = new URLSearchParams({ pa: upiId.trim(), pn: shopName.trim().slice(0, 40) || "Shop", am: round2(amount).toFixed(2), cu: "INR" });
  if (note) q.set("tn", note.slice(0, 40));
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

/** Light check that a UPI ID looks like name@bank (the shopkeeper types it in settings). */
export const isUpiId = (v?: string) => !!v && /^[\w.\-]{2,256}@[a-zA-Z][\w.\-]{1,63}$/.test(v.trim());

/** Split form: a key present = that method is used on this bill; "" = take the remainder. */
export type SplitForm = Partial<Record<PayMethod, string>>;

/** Starting split: the chosen method plus the next most common one. */
export const startSplit = (single: PayMethod): SplitForm => (single === "cash" ? { cash: "", upi: "" } : { [single]: "", cash: "" });

const parseAmt = (v?: string) => {
  if (v === undefined || v.trim() === "") return undefined;
  return parseMoney(v) ?? NaN;
};

/**
 * What the checkout form currently means: the amount per method, which method was auto-filled,
 * and how much is still unassigned (negative = too much typed).
 */
export function formPlan(total: number, single: PayMethod, split: SplitForm | null | undefined) {
  const amounts: Record<PayMethod, number> = { cash: 0, upi: 0, credit: 0 };
  if (!split) {
    amounts[single] = round2(total);
    return { amounts, auto: null as PayMethod | null, left: 0, invalid: false, used: [single] };
  }
  // Only the methods switched on for this bill take part; the one left empty gets the remainder.
  const used = PAY_METHODS.filter((m) => split[m] !== undefined);
  const raw: SplitInput = {};
  for (const m of used) raw[m] = parseAmt(split[m]);
  const invalid = used.some((m) => raw[m] !== undefined && (Number.isNaN(raw[m]) || (raw[m] as number) < 0));
  const empty = used.filter((m) => raw[m] === undefined);
  const filled = invalid ? raw : autoFill(total, raw, used);
  for (const m of used) amounts[m] = invalid ? 0 : Math.max(0, filled[m] ?? 0);
  const left = round2(total - used.reduce((a, m) => a + (Number.isNaN(filled[m]) ? 0 : (filled[m] ?? 0)), 0));
  return { amounts, auto: empty.length === 1 ? empty[0] : null, left, invalid, used };
}

/** CSV header for bills (the split columns sit after `payment`). */
export const SALES_CSV_HEADERS = [
  "bill_id", "date", "time", "items", "total", "cost", "payment",
  "cash", "upi", "upi_pending", "credit", "cash_tendered", "change", "upi_ref",
  "customer", "status", "returned_total", "net_total",
];

/** cash, upi (confirmed), upi_pending, credit, cash_tendered, change, upi_ref for one bill. */
export function salePaymentCSV(s: Sale): (string | number)[] {
  const parts = paymentsOf(s);
  const cashPart = parts.find((p) => p.method === "cash");
  const refs = parts.filter((p) => p.method === "upi" && p.ref).map((p) => p.ref as string);
  return [
    partSum(parts, "cash"),
    partSum(parts, "upi", "paid"),
    partSum(parts, "upi", "pending"),
    partSum(parts, "credit"),
    cashPart?.tendered ?? "",
    cashPart?.change ?? "",
    refs.join(" "),
  ];
}
