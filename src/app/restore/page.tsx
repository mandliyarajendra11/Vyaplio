"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { LangToggle } from "@/components/LangToggle";
import { Wordmark } from "@/components/Wordmark";
import { AuthError } from "@/lib/auth";
import { BackupError, readBackup, type BackupData, type BackupPreview } from "@/lib/backup";
import { recoverFromBackup } from "@/lib/backupRecovery";
import { fmtDate } from "@/lib/dates";
import type { Locale } from "@/lib/db";
import { unlockApp } from "@/lib/lock";

export default function RestorePage() {
  const t = useTranslations("restoreEntry");
  const tb = useTranslations("backup");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [body, setBody] = useState<string | null>(null);
  const [filePassword, setFilePassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [ready, setReady] = useState<{ data: BackupData; preview: BackupPreview } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (text: string, pass?: string) => {
    setBusy(true);
    setError(null);
    try {
      setReady(await readBackup(text, pass));
      setNeedsPassword(false);
    } catch (e) {
      setReady(null);
      setNeedsPassword(e instanceof BackupError && (e.code === "needPassword" || e.code === "wrongPassword"));
      setError(e instanceof BackupError ? tb(`err.${e.code}`, { detail: e.detail ?? "" }) : t("readError"));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const user = await recoverFromBackup(ready.data, email, password);
      unlockApp(user.id);
      router.replace("/");
    } catch (e) {
      setError(e instanceof AuthError ? t(e.code === "short" ? "shortPassword" : e.code === "exists" ? "existingShop" : "wrongAccountPassword") : e instanceof BackupError ? tb(`err.${e.code}`, { detail: e.detail ?? "" }) : t("restoreError"));
    } finally {
      setBusy(false);
    }
  };

  return <main className="page-enter mx-auto min-h-dvh max-w-[560px] space-y-6 px-5 py-7">
    <div className="flex items-center justify-between gap-3"><Wordmark size="sm" sub={false} /><LangToggle /></div>
    <header><h1 className="font-brand text-3xl font-bold">{t("title")}</h1><p className="mt-2 text-lg text-ink-soft">{t("intro")}</p></header>
    <section className="card space-y-4 p-5">
      <label className="btn btn-ghost w-full cursor-pointer">{tb("choose")}
        <input type="file" accept="application/json,.json,text/plain" className="sr-only" onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setReady(null); setNeedsPassword(false); setFilePassword("");
          const text = await file.text(); setBody(text); await check(text);
        }} />
      </label>
      {needsPassword && body && <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void check(body, filePassword); }}>
        <label className="label" htmlFor="backup-password">{tb("needPassword")}</label>
        <input id="backup-password" className="input" type="password" value={filePassword} onChange={(e) => setFilePassword(e.target.value)} required />
        <button className="btn btn-teal w-full" disabled={busy}>{tb("open")}</button>
      </form>}
      {ready && <div className="space-y-4" data-testid="restore-preview">
        <div className="rounded-2xl bg-paper-2 p-4"><h2 className="text-xl font-bold">{ready.preview.shopName}</h2>
          <p className="mt-1 text-ink-soft">{tb("previewDate", { date: fmtDate(ready.preview.exportedAt, locale, "d MMM yyyy") })}</p>
          <p className="num font-semibold">{tb("previewCounts", { products: ready.preview.products, customers: ready.preview.customers, bills: ready.preview.bills })}</p>
        </div>
        <p className="font-semibold">{t("accountPrompt")}</p>
        <label className="label" htmlFor="restore-email">{t("email")}</label>
        <input id="restore-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="label" htmlFor="restore-password">{t("password")}</label>
        <input id="restore-password" className="input" type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="text-sm text-ink-soft">{t("accountHint")}</p>
        <button className="btn btn-primary w-full" type="button" disabled={busy || !email || password.length < 6} onClick={() => void restore()}>{busy ? t("restoring") : t("confirm")}</button>
      </div>}
      {error && <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}
    </section>
    <Link href="/login" className="btn btn-ghost w-full">← {t("back")}</Link>
  </main>;
}
