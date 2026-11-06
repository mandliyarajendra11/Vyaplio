import type { useTranslations } from "next-intl";
import { cashDayText, type CashDay } from "./cash";
import type { Alerts } from "./alerts";
import type { Locale, Shop } from "./db";
import { formatINR } from "./money";
import type { DayStats } from "./stats";

type T = ReturnType<typeof useTranslations>;

/** One private, manually shared summary. Open days are marked as still open. */
export function closeoutText(t: T, day: CashDay, shop: Shop, locale: Locale, stats: DayStats, alerts: Alerts) {
  const pending = alerts.pendingUpi.reduce((sum, bill) => sum + bill.pending, 0);
  const stock = alerts.shortage.length + alerts.low.length + alerts.expiring.length;
  return [
    cashDayText(t, day, shop, locale).replace(/\n— Vyaplio$/, ""),
    t("closeout.waSales", { amount: formatINR(stats.total), count: stats.count }),
    t("closeout.waCollected", { amount: formatINR(day.cashIn.udhaar + day.upi.udhaar) }),
    ...(pending > 0 ? [t("closeout.waPending", { amount: formatINR(pending), count: alerts.pendingUpi.length })] : []),
    ...(stock > 0 ? [t("closeout.waStock", { shortage: alerts.shortage.length, low: alerts.low.length, expiring: alerts.expiring.length })] : []),
    "— Vyaplio",
  ].join("\n");
}
