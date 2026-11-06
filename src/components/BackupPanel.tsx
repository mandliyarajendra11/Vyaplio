"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { BackupError, createBackup, readBackup, restoreBackup, shareOrDownload, type BackupData, type BackupPreview } from "@/lib/backup";
import { markBackup } from "@/lib/backupReminder";
import { fmtDate } from "@/lib/dates";
import type { Locale } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { IconDownload } from "./Icons";

type T = ReturnType<typeof useTranslations>;
const errText = (t: T, e: unknown) => (e instanceof BackupError ? t(`err.${e.code}`, { detail: e.detail ?? "" }) : t("err.notJson", { detail: "" }));

/** Make a backup file of the whole shop and hand it to the share sheet (WhatsApp, Files…). */
export function BackupExport({ shopId, onToast }: { shopId: string; onToast: (msg: string) => void }) {
  const t = useTranslations("backup");
  const [lock, setLock] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const { text, filename } = await createBackup(shopId, lock && password ? password : undefined);
      const r = await shareOrDownload(text, filename);
      if (r !== "cancelled") {
        await markBackup(shopId);
        onToast(t("made", { name: filename }));
      }
    } catch (e) {
      setError(errText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <label className="flex min-h-[48px] items-center gap-3 font-semibold">
        <input type="checkbox" className="h-6 w-6 accent-teal" checked={lock} onChange={(e) => setLock(e.target.checked)} />
        {t("lock")}
      </label>
      {lock && (
        <div>
          <label className="label" htmlFor="bk-pass">
            {t("password")}
          </label>
          <input id="bk-pass" type="password" autoComplete="new-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-sm text-brick">{t("lockHint")}</p>
        </div>
      )}
      <button type="button" className="btn btn-teal w-full" disabled={busy || (lock && !password)} onClick={make}>
        <IconDownload /> {busy ? t("making") : t("make")}
      </button>
      {error && (
        <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Restore from a backup file: read → (password) → validate → preview → explicit confirm → replace.
 * A file that fails any check is refused and nothing on the phone changes.
 */
export function BackupRestore({ ownerId, currentShop, onRestored }: { ownerId: string; currentShop?: { id: string; name: string }; onRestored: (shopName: string) => void }) {
  const t = useTranslations("backup");
  const tc = useTranslations("common");
  const locale = useLocale() as Locale;
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [needPass, setNeedPass] = useState(false);
  const [password, setPassword] = useState("");
  const [ready, setReady] = useState<{ data: BackupData; preview: BackupPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setText(null);
    setNeedPass(false);
    setPassword("");
    setReady(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const check = async (body: string, pass?: string) => {
    setBusy(true);
    setError(null);
    try {
      setReady(await readBackup(body, pass));
      setNeedPass(false);
    } catch (e) {
      if (e instanceof BackupError && (e.code === "needPassword" || e.code === "wrongPassword")) setNeedPass(true);
      else reset();
      setError(`${errText(t, e)} ${t("nothingChanged")}`);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setReady(null);
    setNeedPass(false);
    setPassword("");
    if (!file) return;
    const body = await file.text();
    setText(body);
    await check(body);
  };

  const confirm = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await restoreBackup(ready.data, ownerId, currentShop?.id);
      const name = ready.preview.shopName;
      reset();
      onRestored(name);
    } catch (e) {
      setError(`${errText(t, e)} ${t("nothingChanged")}`);
    } finally {
      setBusy(false);
    }
  };

  const p = ready?.preview;
  return (
    <div className="space-y-3" data-testid="backup-restore">
      <p className="text-ink-soft">{t("restoreHint")}</p>
      <label className="btn btn-ghost w-full cursor-pointer">
        {t("choose")}
        <input ref={fileRef} type="file" accept="application/json,.json,text/plain" className="sr-only" onChange={onFile} data-testid="backup-file" />
      </label>
      {needPass && text && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void check(text, password);
          }}
        >
          <label className="label" htmlFor="bk-open-pass">
            {t("needPassword")}
          </label>
          <input id="bk-open-pass" type="password" autoComplete="off" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="btn btn-teal w-full" disabled={busy || !password}>
            {t("open")}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
          {error}
        </p>
      )}
      {p && (
        <div className="card space-y-2 p-4" data-testid="backup-preview">
          <h3 className="text-lg font-bold">{t("previewTitle")}</h3>
          <p className="text-xl font-semibold">
            {p.shopName}
            {p.ownerName ? ` · ${p.ownerName}` : ""}
          </p>
          <p className="text-ink-soft">
            {t("previewDate", { date: fmtDate(p.exportedAt, locale, "d MMM yyyy, h:mm a") })}
            {p.encrypted ? ` · ${t("locked")}` : ""}
          </p>
          <p className="num font-semibold">{t("previewCounts", { products: p.products, customers: p.customers, bills: p.bills })}</p>
          <p className="num">{t("previewMore", { corrections: p.corrections, ledger: p.ledger })}</p>
          <p className="num font-semibold">{t("previewUdhaar", { amount: formatINR(p.udhaarTotal) })}</p>
          {(p.customerOrders > 0 || p.baskets > 0) && <p className="num" data-testid="backup-preview-orders">{t("previewOrders", { orders: p.customerOrders, baskets: p.baskets })}</p>}
          {p.suppliers > 0 && <p className="num">{t("previewSuppliers", { suppliers: p.suppliers, purchases: p.purchases, owed: formatINR(p.supplierOwed) })}</p>}
          {p.warnings.map((w) => (
            <p key={w.code} className="text-sm font-semibold text-brick">
              {t(w.code === "balanceMismatch" ? "warnBalance" : "warnStock", { count: w.count })}
            </p>
          ))}
          <p className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
            {currentShop ? t("replaceWarn", { name: currentShop.name }) : t("replaceNone")}
          </p>
          <button type="button" className="btn btn-primary w-full" disabled={busy} onClick={confirm}>
            {t("confirm")}
          </button>
          <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={reset}>
            {tc("cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
