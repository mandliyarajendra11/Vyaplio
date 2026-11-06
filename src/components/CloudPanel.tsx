"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { cloudFinishPhoneLink, cloudSendPhoneOtp, cloudSignIn, cloudSignOut, cloudSignUp, cloudStartPhoneLink, cloudUser, linkShop, recoverFromCloud, recoverFromCloudPhone, replaceWithCloudShop, type CloudUser } from "@/lib/cloud";
import { fmtDate } from "@/lib/dates";
import type { Locale, Shop } from "@/lib/db";
import { useCloudLink, usePendingSync, useSyncRunning, useSyncStatus } from "@/lib/hooks";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { SyncError, syncNow } from "@/lib/sync";

type T = ReturnType<typeof useTranslations>;

/** Human text for a sync/cloud error (never a fake success). */
export function cloudErrorText(t: T, e: unknown) {
  if (e instanceof SyncError) return t(`err.${e.code}`, { detail: e.detail ?? "" });
  return t("err.server", { detail: "" });
}

function ErrorBox({ text, detail }: { text: string; detail?: string }) {
  const t = useTranslations("cloud");
  return (
    <div role="alert" className="rounded-xl bg-brick/10 px-4 py-2 text-brick">
      <p className="font-semibold">{text}</p>
      {detail && <p className="mt-1 text-sm break-words">{t("detail", { detail })}</p>}
    </div>
  );
}

function CredentialsForm({ submitLabel, busy, onSubmit, idPrefix }: { submitLabel: string; busy: boolean; onSubmit: (email: string, password: string) => void; idPrefix: string }) {
  const t = useTranslations("cloud");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(email.trim(), password);
      }}
    >
      <div>
        <label className="label" htmlFor={`${idPrefix}-email`}>
          {t("email")}
        </label>
        <input id={`${idPrefix}-email`} type="email" required autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-password`}>
          {t("password")}
        </label>
        <input id={`${idPrefix}-password`} type="password" required minLength={6} autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button type="submit" className="btn btn-teal w-full" disabled={busy}>
        {busy ? t("busy") : submitLabel}
      </button>
    </form>
  );
}

function PhoneLink({ verified, uid, onLinked }: { verified?: string; uid: string; onLinked: () => void }) {
  const t = useTranslations("phoneAuth");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState<{ phone: string; uid: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof SyncError && e.detail === "phoneInvalid" ? t("invalidPhone") : t("failed")); } finally { setBusy(false); } };
  return <div className="rounded-2xl bg-paper-2 p-4 space-y-3">
    <p className="font-bold">{t("protectTitle")}</p>
    {verified ? <p className="font-semibold text-leaf">{t("verified", { phone: verified })}</p> : <>
      <p className="text-sm text-ink-soft">{t("protectHint")}</p>
      <label className="block"><span className="label">{t("phone")}</span><input className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9876543210" /></label>
      {pending ? <><label className="block"><span className="label">{t("code")}</span><input className="input num" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label><button type="button" className="btn btn-teal w-full" disabled={busy} onClick={() => void run(async () => { await cloudFinishPhoneLink(pending.phone, code, pending.uid); setPending(null); onLinked(); })}>{t("verify")}</button><button type="button" className="min-h-12 w-full font-semibold text-teal" disabled={busy} onClick={() => setPending(null)}>{t("changePhone")}</button></> : <button type="button" className="btn btn-teal w-full" disabled={busy} onClick={() => void run(async () => setPending(await cloudStartPhoneLink(phone, uid)))}>{t("send")}</button>}
    </>}
    {error && <p role="alert" className="font-semibold text-brick">{error}</p>}
  </div>;
}

/** More screen: link this shop to the cloud, see what is still waiting, sync, sign out. */
export function CloudPanel({ shop, onToast }: { shop: Shop; onToast: (msg: string) => void }) {
  const t = useTranslations("cloud");
  const tm = useTranslations("more");
  const locale = useLocale() as Locale;
  const configured = isSupabaseConfigured();
  const link = useCloudLink();
  const status = useSyncStatus();
  const pending = usePendingSync(shop.id) ?? 0;
  const running = useSyncRunning();
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ name: string } | null>(null);

  const [userTick, setUserTick] = useState(0);
  const refreshUser = useCallback(() => setUserTick((n) => n + 1), []);
  useEffect(() => {
    if (!configured) return;
    let live = true;
    void cloudUser()
      .catch(() => null)
      .then((u) => {
        if (live) setUser(u);
      });
    return () => {
      live = false;
    };
  }, [configured, userTick]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError({ text: cloudErrorText(t, e), detail: e instanceof SyncError && e.code !== "conflict" ? e.detail : undefined });
    } finally {
      setBusy(false);
      refreshUser();
    }
  };

  const doLink = () =>
    run(async () => {
      const r = await linkShop(shop, shop.ownerId);
      if (r.status === "conflict") setConflict({ name: r.cloudShop.name });
      else {
        setConflict(null);
        onToast(t("linked"));
      }
    });

  const signInAndLink = (email: string, password: string) =>
    run(async () => {
      if (mode === "signUp") {
        const r = await cloudSignUp(email, password);
        if (r.confirm) {
          setNote(t("confirmEmail", { email }));
          setMode("signIn");
          return;
        }
      } else await cloudSignIn(email, password);
      if (shop.isDemo) return;
      const r = await linkShop(shop, shop.ownerId);
      if (r.status === "conflict") setConflict({ name: r.cloudShop.name });
      else onToast(t("linked"));
    });

  const replace = () => {
    if (!window.confirm(t("replaceConfirm", { name: shop.name }))) return;
    void run(async () => {
      await replaceWithCloudShop(shop.ownerId, shop.id);
      setConflict(null);
      onToast(t("replaced"));
    });
  };

  const sync = () =>
    run(async () => {
      const r = await syncNow();
      if (r.error) throw r.error;
      if (r.skipped) throw new SyncError(r.reason ?? "notLinked");
      onToast(t("syncDone", { pushed: r.pushed, pulled: r.pulled }));
    });

  const signOut = () =>
    run(async () => {
      await cloudSignOut();
      setConflict(null);
      onToast(t("signedOut"));
    });

  if (!configured)
    return (
      <section>
        <h2 className="eyebrow mb-2">{t("title")}</h2>
        <p className="text-lg font-semibold" data-testid="pending">
          {tm("pendingLocal", { count: pending })}
        </p>
        <p className="mt-1 text-ink-soft">{t("notConfigured")}</p>
        <p className="mt-1 text-sm text-ink-soft">{t("notConfiguredHint")}</p>
      </section>
    );

  const mine = link && link.shopId === shop.id && link.localUserId === shop.ownerId ? link : null;
  const foreign = link && !mine ? link : null;
  const when = (ms: number) => fmtDate(ms, locale, "d MMM, h:mm a");

  return (
    <section className="space-y-3" data-testid="cloud-panel">
      <h2 className="eyebrow">{t("title")}</h2>
      {mine ? (
        <div className="card space-y-3 p-5">
          <p className="font-semibold text-teal">{mine.email ? t("linkedAs", { email: mine.email }) : t("linked")}</p>
          {user?.id === mine.uid ? <PhoneLink verified={user.phone} uid={mine.uid} onLinked={refreshUser} /> : <p className="rounded-xl bg-mustard-soft p-3 font-semibold">{t("phoneSignInFirst")}</p>}
          <p className="text-lg font-semibold" data-testid="pending">
            {tm("pending", { count: pending })}
          </p>
          {status ? (
            status.ok ? (
              <p className="text-ink-soft">{t("lastOk", { time: when(status.at) })}</p>
            ) : (
              <>
                <p className="text-ink-soft">{t("lastFail", { time: when(status.at) })}</p>
                {status.error && <ErrorBox text={t(`err.${status.error.code}`, { detail: status.error.detail ?? "" })} detail={status.error.detail} />}
              </>
            )
          ) : (
            <p className="text-ink-soft">{t("never")}</p>
          )}
          <button type="button" className="btn btn-teal w-full" disabled={busy || running} onClick={sync}>
            {busy || running ? t("syncing") : t("syncNow")}
          </button>
          <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={signOut}>
            {t("signOut")}
          </button>
          <p className="text-sm text-ink-soft">{t("signOutHint")}</p>
        </div>
      ) : (
        <div className="card space-y-3 p-5">
          <p className="text-ink-soft">{t("intro")}</p>
          <p className="text-lg font-semibold" data-testid="pending">
            {tm("pendingLocal", { count: pending })}
          </p>
          {foreign ? (
            <>
              <p className="font-semibold">{t("otherAccount", { email: foreign.email })}</p>
              <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={signOut}>
                {t("signOut")}
              </button>
            </>
          ) : shop.isDemo ? (
            <p className="font-semibold">{t("demo")}</p>
          ) : conflict ? (
            <>
              <ErrorBox text={t("conflict", { name: conflict.name })} />
              <p className="text-ink-soft">{t("conflictHelp")}</p>
              <button type="button" className="btn btn-ghost w-full text-brick" disabled={busy} onClick={replace}>
                {t("replace")}
              </button>
              <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={signOut}>
                {t("signOut")}
              </button>
            </>
          ) : user ? (
            <>
              <p className="font-semibold">{t("signedInAs", { email: user.email })}</p>
              <button type="button" className="btn btn-teal w-full" disabled={busy} onClick={doLink}>
                {busy ? t("linking") : t("link")}
              </button>
              <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={signOut}>
                {t("signOut")}
              </button>
            </>
          ) : user === null ? (
            <>
              <CredentialsForm idPrefix="cloud" busy={busy} submitLabel={mode === "signIn" ? t("signIn") : t("signUp")} onSubmit={signInAndLink} />
              <button type="button" className="min-h-[48px] w-full font-semibold text-teal" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
                {mode === "signIn" ? t("toSignUp") : t("toSignIn")}
              </button>
              <p className="text-sm text-ink-soft">{t("otpSoon")}</p>
            </>
          ) : null}
        </div>
      )}
      {note && <p className="rounded-xl bg-teal/10 px-4 py-2 font-semibold text-teal">{note}</p>}
      {error && <ErrorBox text={error.text} detail={error.detail} />}
    </section>
  );
}

/** Login screen: a new phone signs in to the cloud and downloads the whole shop. */
export function CloudRecover() {
  const t = useTranslations("cloud");
  const tp = useTranslations("phoneAuth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [method, setMethod] = useState<"email" | "phone">("phone");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  if (!isSupabaseConfigured()) return null;
  const recover = async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      await recoverFromCloud(email, password); // sets the session; the login page then opens the shop
    } catch (e) {
      setError({ text: cloudErrorText(t, e), detail: e instanceof SyncError && !["auth", "conflict", "noCloudShop"].includes(e.code) ? e.detail : undefined });
    } finally {
      setBusy(false);
    }
  };
  const phoneRun = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError({ text: e instanceof SyncError && e.detail === "phoneInvalid" ? tp("invalidPhone") : e instanceof SyncError && e.detail === "passwordShort" ? tp("passwordShort") : cloudErrorText(t, e) }); }
    finally { setBusy(false); }
  };
  return (
    <div className="card mt-6 space-y-3 p-5" data-testid="cloud-recover">
      <h2 className="text-xl font-bold">{t("recoverTitle")}</h2>
      <p className="text-ink-soft">{t("recoverHint")}</p>
      <div className="grid grid-cols-2 gap-2"><button type="button" className={`btn ${method === "phone" ? "btn-teal" : "btn-ghost"}`} onClick={() => setMethod("phone")}>{tp("byPhone")}</button><button type="button" className={`btn ${method === "email" ? "btn-teal" : "btn-ghost"}`} onClick={() => setMethod("email")}>{tp("byEmail")}</button></div>
      {method === "email" ? <CredentialsForm idPrefix="recover" busy={busy} submitLabel={busy ? t("recovering") : t("recover")} onSubmit={recover} /> : <div className="space-y-3">
        <p className="text-sm text-ink-soft">{tp("recoverHint")}</p>
        <label className="block"><span className="label">{tp("phone")}</span><input className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9876543210" /></label>
        {sentTo ? <><p className="font-semibold">{tp("sentTo", { phone: sentTo })}</p><label className="block"><span className="label">{tp("code")}</span><input className="input num" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label><label className="block"><span className="label">{tp("offlinePassword")}</span><input className="input" type="password" autoComplete="new-password" minLength={6} value={localPassword} onChange={(e) => setLocalPassword(e.target.value)} /></label><p className="text-sm text-ink-soft">{tp("offlineHint")}</p><button type="button" className="btn btn-primary w-full" disabled={busy || !code || localPassword.length < 6} onClick={() => void phoneRun(async () => { await recoverFromCloudPhone(sentTo, code, localPassword); })}>{busy ? t("recovering") : tp("recover")}</button><button type="button" className="min-h-12 w-full font-semibold text-teal" disabled={busy} onClick={() => setSentTo("")}>{tp("changePhone")}</button></> : <button type="button" className="btn btn-teal w-full" disabled={busy} onClick={() => void phoneRun(async () => { setSentTo(await cloudSendPhoneOtp(phone)); })}>{tp("send")}</button>}
      </div>}
      {error && <ErrorBox text={error.text} detail={error.detail} />}
    </div>
  );
}
