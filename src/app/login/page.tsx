"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CloudRecover } from "@/components/CloudPanel";
import { LangToggle } from "@/components/LangToggle";
import { Wordmark } from "@/components/Wordmark";
import { AuthError, login } from "@/lib/auth";
import { useSessionUser, useShopForUser } from "@/lib/hooks";
import { unlockApp } from "@/lib/lock";
import { getSupabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const t = useTranslations("login");
  const tcl = useTranslations("cloud");
  const router = useRouter();
  const userId = useSessionUser();
  const shop = useShopForUser(userId);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (userId && shop) router.replace("/");
    else if (userId && shop === null) router.replace("/setup");
  }, [userId, shop, router]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      try {
        // Existing shop accounts still open locally, including when the phone is offline.
        unlockApp((await login(email, password)).id);
        return;
      } catch (localError) {
        if (!(localError instanceof AuthError) || localError.code !== "invalid") throw localError;
        const cloud = getSupabase();
        if (!cloud) throw localError;
        const { data, error: cloudError } = await cloud.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
        if (cloudError || !data.session) throw localError;
        const check = await fetch("/api/admin/session", { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store" });
        if (check.ok || check.status === 428) { router.replace(check.ok ? "/admin" : "/admin/activate"); return; }
        if (check.status === 503) throw new Error("adminSetup");
        throw localError;
      }
    } catch (e) {
      const code = e instanceof AuthError ? e.code : e instanceof Error && e.message === "adminSetup" ? "adminSetup" : "invalid";
      setError(t(code === "adminSetup" ? "adminSetup" : code === "exists" ? "errExists" : code === "short" ? "errShort" : "errInvalid"));
    } finally {
      setBusy(false);
    }
  };

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
        <Link href="/pricing" className="btn btn-primary min-h-[64px] w-full text-xl">{t("newShopPricing")} →</Link>
        <p className="mt-2 text-center text-ink-soft">{t("purchaseFirst")}</p>
        <Link href="/activate" className="btn btn-teal mt-5 min-h-[64px] w-full text-lg">{t("activatePaidShop")} →</Link>
        <div className="my-6 flex items-center gap-3 text-ink-soft">
          <span className="h-px flex-1 bg-line" />
          {t("or")}
          <span className="h-px flex-1 bg-line" />
        </div>

        <form
          className="card space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            // Server-verified admin accounts use this same form; shop accounts remain local-first.
            void run();
          }}
        >
          <div>
            <label className="label" htmlFor="email">
              {t("email")}
            </label>
            <input id="email" type="email" required autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
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
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}
          <button className="btn btn-teal w-full" disabled={busy} type="submit">
            {t("login")}
          </button>
          <p className="text-center text-sm text-ink-soft">{t("localNote")}</p>
        </form>
        <CloudRecover />
        <Link href="/restore" className="mt-4 flex min-h-12 items-center justify-center font-bold text-teal underline">{t("restoreBackup")}</Link>
        <p className="text-center text-sm text-ink-soft">{tcl("backupHint")}</p>
      </section>
    </div>
  );
}
