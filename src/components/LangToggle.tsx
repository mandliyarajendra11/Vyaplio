"use client";

import { useLocale } from "next-intl";
import type { Locale } from "@/lib/db";
import { updateShop } from "@/lib/ops";
import { setLocale } from "@/lib/prefs";

export function LangToggle({ shopId }: { shopId?: string }) {
  const locale = useLocale() as Locale;
  const pick = (l: Locale) => {
    setLocale(l);
    if (shopId) void updateShop(shopId, { language: l });
  };
  return (
    <div role="group" aria-label="Language" className="inline-flex rounded-xl border-2 border-line bg-card p-0.5">
      {(["hi", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => pick(l)}
          aria-pressed={locale === l}
          className={`min-h-[48px] min-w-[52px] rounded-[0.6rem] px-3 font-bold ${locale === l ? "bg-teal text-paper" : "text-ink-soft"}`}
        >
          {l === "hi" ? "हिं" : "EN"}
        </button>
      ))}
    </div>
  );
}
