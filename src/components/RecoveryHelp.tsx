"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { loadBackupState, REMIND_CHOICES, setRemindDays } from "@/lib/backupReminder";
import { fmtDate } from "@/lib/dates";
import { db, type Locale, type Shop } from "@/lib/db";
import { useNow, useSessionUser } from "@/lib/hooks";
import { recoveryCardLines } from "@/lib/recoveryCard";
import { getCloudLink } from "@/lib/sync";
import { waLink } from "@/lib/whatsapp";
import { Sheet } from "./Sheet";

/** Plain points about losing the phone (setup + More). */
export function RecoveryPoints() {
  const t = useTranslations("recoveryMore");
  return (
    <ul className="space-y-2 text-lg" data-testid="recovery-points">
      {(["lost", "whatsapp", "cloud", "pin"] as const).map((k) => (
        <li key={k} className="flex gap-3">
          <span aria-hidden className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-mustard" />
          <span className="min-w-0">{t(k)}</span>
        </li>
      ))}
    </ul>
  );
}

/** More → "Phone lost?": guidance, last backup, reminder interval and the recovery card. */
export function RecoveryHelp({ shop }: { shop: Shop }) {
  const t = useTranslations();
  const tr = useTranslations("recoveryMore");
  const locale = useLocale() as Locale;
  const now = useNow();
  const userId = useSessionUser();
  const [card, setCard] = useState(false);
  const state = useLiveQuery(() => loadBackupState(shop, now || Date.now()), [shop, now]);
  const user = useLiveQuery(async () => (userId ? ((await db.users.get(userId)) ?? null) : null), [userId]);
  const link = useLiveQuery(async () => (await getCloudLink()) ?? null, []);
  const cloudEmail = link && link.shopId === shop.id ? link.email : null;
  const last = state?.lastAt ? fmtDate(state.lastAt, locale, "d MMM yyyy") : null;
  const lines = recoveryCardLines((k, v) => tr(k, v), {
    shopName: shop.name,
    shopId: shop.id,
    ownerName: shop.ownerName,
    accountEmail: user?.email,
    cloudEmail,
    lastBackup: last,
    lastBackupVia: state?.via,
  });
  return (
    <section className="card space-y-4 p-5" data-testid="recovery-help">
      <h2 className="text-xl font-bold">{t("recovery.title")}</h2>
      <p className="text-ink-soft">{tr("intro")}</p>
      <RecoveryPoints />
      <ol className="list-decimal space-y-2 pl-5 text-lg">
        <li>{t("recovery.step1")}</li>
        <li>{t("recovery.step2")}</li>
        <li className="font-semibold text-brick">{t("recovery.step3")}</li>
      </ol>
      <p className={`font-semibold ${state?.lastAt ? "text-ink" : "text-brick"}`} data-testid="last-backup">
        {state?.lastAt ? tr("last", { date: last ?? "", via: tr(state.via === "cloud" ? "viaCloud" : "viaFile") }) : tr("never")}
      </p>
      <fieldset>
        <legend className="label">{tr("remindTitle")}</legend>
        <div className="flex flex-wrap gap-2">
          {REMIND_CHOICES.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={state?.remindDays === n}
              onClick={() => void setRemindDays(shop.id, n)}
              className={`min-h-12 min-w-12 rounded-full border-2 px-4 font-bold ${state?.remindDays === n ? "border-teal bg-teal text-paper" : "border-line bg-card text-ink"}`}
            >
              {tr("remindEvery", { n })}
            </button>
          ))}
        </div>
      </fieldset>
      <button type="button" className="btn btn-ghost w-full" onClick={() => setCard(true)} data-testid="recovery-card-open">
        {tr("cardOpen")}
      </button>
      <Sheet
        open={card}
        onClose={() => setCard(false)}
        title={tr("cardTitle")}
        footer={
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
            <a className="btn btn-wa" href={waLink(lines.join("\n"), shop.phone)} target="_blank" rel="noreferrer" data-testid="recovery-card-share">
              {tr("cardShare")}
            </a>
            <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
              {tr("cardPrint")}
            </button>
          </div>
        }
      >
        <div className="print-card rounded-2xl border-2 border-dashed border-ink/60 bg-card p-4" data-testid="recovery-card">
          <p className="text-lg font-bold">{lines[0]}</p>
          <div className="mt-2 space-y-1 break-words whitespace-pre-line">{lines.slice(1).join("\n")}</div>
        </div>
      </Sheet>
    </section>
  );
}
