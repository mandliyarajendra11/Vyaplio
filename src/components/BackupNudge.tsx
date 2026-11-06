"use client";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { loadBackupState, snoozeReminder } from "@/lib/backupReminder";
import type { Shop } from "@/lib/db";

/** Home: "no backup for N days" card, until a backup is made or it is snoozed for a day. */
export function BackupNudge({ shop, now }: { shop: Shop; now: number }) {
  const t = useTranslations("nudge");
  const state = useLiveQuery(() => loadBackupState(shop, now || Date.now()), [shop, now]);
  if (!state?.due) return null;
  return (
    <section className="rounded-2xl border-2 border-mustard bg-mustard-soft/60 p-4" role="status" data-testid="backup-nudge">
      <p className="text-lg font-bold">{state.lastAt ? t("title", { days: state.days }) : t("neverTitle")}</p>
      <p className="mt-1">{t("body")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href="/more#backup" className="btn btn-teal">
          {t("make")}
        </Link>
        <button type="button" className="btn btn-ghost" onClick={() => void snoozeReminder(shop.id)}>
          {t("later")}
        </button>
      </div>
    </section>
  );
}
