import { differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";
import { enIN, hi } from "date-fns/locale";
import type { Locale } from "./db";

export const DAY_MS = 86_400_000;
export const dayKey = (ms: number) => format(ms, "yyyy-MM-dd");
export const startOfDayMs = (ms: number) => startOfDay(ms).getTime();
export const isoDate = (ms: number) => format(ms, "yyyy-MM-dd");

export function fmtDate(value: number | string, locale: Locale, pattern = "d MMM") {
  const d = typeof value === "string" ? parseISO(value) : value;
  return format(d, pattern, { locale: locale === "hi" ? hi : enIN });
}

export const fmtTime = (ms: number, locale: Locale) => fmtDate(ms, locale, "h:mm a");
export const daysUntil = (iso: string, now: number) => differenceInCalendarDays(parseISO(iso), now);
export const daysSince = (ms: number, now: number) => differenceInCalendarDays(now, ms);
