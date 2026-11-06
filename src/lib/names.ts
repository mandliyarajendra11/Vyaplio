import type { Locale } from "./db";

/** Primary + secondary name for the current UI language. */
export function names(item: { nameHi: string; nameEn: string }, locale: Locale) {
  const primary = locale === "hi" ? item.nameHi || item.nameEn : item.nameEn || item.nameHi;
  const secondary = locale === "hi" ? item.nameEn : item.nameHi;
  return { primary, secondary: secondary && secondary !== primary ? secondary : "" };
}
