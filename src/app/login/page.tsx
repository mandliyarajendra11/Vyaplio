"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { LangToggle } from "@/components/LangToggle";
import { RestoreShopForm } from "@/components/RestoreShopForm";
import { Wordmark } from "@/components/Wordmark";
import { AuthError, login } from "@/lib/auth";
import { recoverFromCloud } from "@/lib/cloud";
import { useSessionUser, useShopForUser } from "@/lib/hooks";
import { unlockApp } from "@/lib/lock";
import { getSupabase } from "@/lib/supabase/client";

type PasswordChange = "shop" | "admin";

export default function LoginPage() {
  const t = useTranslations("login");
  const ta = useTranslations("activation");
  const tcl = useTranslations("cloud");
  const router = useRouter();
  const userId = useSessionUser();
  const shop = useShopForUser(userId);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [change, setChange] = useState<PasswordChange | null>(null);
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (userId && shop) router.replace("/");
    else if (userId && shop === null) router.replace("/setup");
  }, [userId, shop, router]);

  const openCloudShop = async (nextPassword: string) => {
    const opened = await recoverFromCloud(email, nextPassword);
    unlockApp(opened.ownerId);
  };

  const saveNewPassword = async () => {
    const cloud = getSupabase();
    const session = (await cloud?.auth.getSession())?.data.session;
    if (!cloud || !session) {
      setChange(null);
      setError(t("errInvalid"));
      return;
    }
    const path = change === "admin" ? "/api/admin/change-password" : "/api/access/change-password";
    const body = change === "admin" ? { password: newPassword, currentPassword: password } : { password: newPassword };
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(response.status === 403 ? "wrongTemporary" : "failed");
    if (change === "admin") {
      const { error: signInError } = await cloud.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: newPassword });
      if (signInError) throw new Error("failed");
      router.replace("/admin");
      return;
    }
    await openCloudShop(newPassword);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (change) {
        await saveNewPassword();
        return;
      }
      try {
        unlockApp((await login(email, password)).id);
        return;
      } catch (localError) {
        if (!(localError instanceof AuthError) || localError.code !== "invalid") throw localError;
        const cloud = getSupabase();
        if (!cloud) throw localError;
        const { data, error: cloudError } = await cloud.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
        if (cloudError || !data.session || !data.user) throw localError;
        const check = await fetch("/api/admin/session", { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store" });
        if (check.status === 428) {
          setChange("admin");
          return;
        }
        if (check.ok) {
          router.replace("/admin");
          return;
        }
        if (check.status === 503) throw new Error("adminSetup");
        const { data: access } = await cloud.from("shop_access").select("must_change_password,status").eq("owner_id", data.user.id).maybeSingle();
        if (access?.status === "active" && access.must_change_password) {
          setChange("shop");
          return;
        }
        if (access?.status === "active") {
          await openCloudShop(password);
          return;
        }
        throw localError;
      }
    } catch (e) {
      const code = e instanceof AuthError ? e.code : e instanceof Error && (e.message === "adminSetup" || e.message === "wrongTemporary" || e.message === "failed") ? e.message : "invalid";
      setError(code === "adminSetup" ? t("adminSetup") : code === "wrongTemporary" ? ta("wrongTemporary") : code === "failed" ? ta("failed") : code === "exists" ? t("errExists") : code === "short" ? t("errShort") : t("errInvalid"));
    } finally {
      setBusy(false);
    }
  };

  const newPasswordReady = newPassword.length >= 12 && newPassword !== password;

  return (
    <div className="page-enter mx-auto grid min-h-dvh max-w-[1080px] grid-cols-[minmax(0,1fr)] items-center gap-10 px-5 py-8 lg:grid-cols-[1.1fr_1fr] lg:px-10">
      <section className="min-w-0">
        <div className="mb-8 flex justify-end lg:hidden">
          <LangToggle />
        </div>
        <Wordmark size="xl" />
        <p className="mt-5 max-w-[30ch] text-2xl leading-snug font-semibold">{t("tagline")}</p>
        <ul className="ruled mt-6 max-w-md text-lg">
          {(["point1", "point2", "point3"] as const).map((k, i) => (
            <li key={k} className="flex items-center gap-3 py-3">
              <span className="num flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal font-bold text-paper">{i + 1}</span>
              {t(k)}
            </li>
          ))}
        </ul>
      </section>

      <section className="min-w-0">
        <div className="mb-4 hidden justify-end lg:flex">
          <LangToggle />
        </div>
        <Link href="/pricing" className="btn btn-primary min-h-[64px] w-full text-xl">
          {t("newShopPricing")} →
        </Link>
        <p className="mt-2 text-center text-ink-soft">{t("purchaseFirst")}</p>
        <div className="my-6 flex items-center gap-3 text-ink-soft">
          <span className="h-px flex-1 bg-line" />
          {t("or")}
          <span className="h-px flex-1 bg-line" />
        </div>

        {backup ? (
          <div className="card space-y-4 p-5">
            <RestoreShopForm />
            <button type="button" className="min-h-12 w-full font-bold text-teal underline" onClick={() => setBackup(false)}>
              {t("backToAccount")}
            </button>
          </div>
        ) : (
          <form
            className="card space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div>
              <label className="label" htmlFor="email">
                {t("email")}
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                className="input"
                value={email}
                disabled={change !== null}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                {t("password")}
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                className="input"
                value={password}
                disabled={change !== null}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {change && (
              <div>
                <label className="label" htmlFor="new-password">
                  {ta("newPassword")}
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={12}
                  className="input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <p className="mt-2 text-sm text-ink-soft">{ta("passwordHint")}</p>
              </div>
            )}
            {error && <p className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}
            <button className="btn btn-teal w-full" disabled={busy || (change !== null && !newPasswordReady)} type="submit">
              {change ? (busy ? ta("working") : ta("activate")) : t("login")}
            </button>
            {change ? (
              <button
                type="button"
                className="min-h-12 w-full font-bold text-teal underline"
                onClick={() => {
                  setChange(null);
                  setNewPassword("");
                  setError(null);
                  void getSupabase()?.auth.signOut();
                }}
              >
                {t("backToAccount")}
              </button>
            ) : (
              <button type="button" className="min-h-12 w-full font-bold text-teal underline" onClick={() => setBackup(true)}>
                {t("restoreBackup")}
              </button>
            )}
            <p className="text-center text-sm text-ink-soft">{t("localNote")}</p>
          </form>
        )}
        {backup && <p className="mt-4 text-center text-sm text-ink-soft">{tcl("backupHint")}</p>}
      </section>
    </div>
  );
}
