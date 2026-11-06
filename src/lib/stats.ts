import type { LedgerEntry, Sale, SaleCorrection } from "./db";
import { round2 } from "./money";
import { moneySplit, paymentsOf } from "./payments";
import { coveragePct, marginTotals } from "./profit";

export interface DayStats {
  /** Net money for the day = sales made that day − corrections made that day. */
  total: number;
  cash: number;
  upi: number;
  credit: number;
  /** UPI not yet confirmed by the shopkeeper (part of total, not of upi). */
  upiPending: number;
  /** Bills paid by more than one method. */
  splitCount: number;
  /** Udhaar actually collected (payments only, not returns). */
  received: number;
  /** Gross margin net of returns (sell − cost), over lines whose buy price is known only. */
  profit: number;
  /** Share of net sales (by value) whose buy price is known, as a whole % (100 = complete). */
  costCoverage: number;
  /** Net sales with no buy price (left out of `profit`). */
  unknownCostSales: number;
  /** Bills still standing (not cancelled). */
  count: number;
  /** Value reversed by returns/cancellations made that day. */
  returns: number;
  returnsCount: number;
}

/**
 * Corrections count on the day they happen (that is when cash/UPI leaves the drawer or
 * udhaar is reduced), so a return today of yesterday's bill lowers today's money.
 */
export function computeDayStats(sales: Sale[], corrections: SaleCorrection[], payments: LedgerEntry[], saleById?: Map<string, Sale>): DayStats {
  // Per-method money from each bill's payment parts, less what each correction gave back that way.
  const { cash, upi, credit, upiPending } = moneySplit(sales, corrections);
  const returns = round2(corrections.reduce((a, c) => a + c.amount, 0));
  // Honest margin: unknown buy prices are left out (never counted as cost 0), see profit.ts.
  const m = marginTotals(sales, corrections, saleById);
  return {
    total: round2(cash + upi + credit + upiPending),
    cash,
    upi,
    credit,
    upiPending,
    splitCount: sales.filter((s) => new Set(paymentsOf(s).map((p) => p.method)).size > 1).length,
    received: round2(payments.filter((e) => e.type === "credit" && e.kind !== "return").reduce((a, e) => a + e.amount, 0)),
    profit: m.margin,
    costCoverage: coveragePct(m),
    unknownCostSales: m.unknownSales,
    count: sales.filter((s) => (s.status ?? "active") !== "cancelled").length,
    returns,
    returnsCount: corrections.length,
  };
}
