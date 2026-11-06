"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { LangToggle } from "@/components/LangToggle";
import { Wordmark } from "@/components/Wordmark";
import { recoverFromCloud } from "@/lib/cloud";
import { getSupabase } from "@/lib/supabase/client";

export default function ActivatePage() {
  const t = useTranslations("activation");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passwordChanged, setPasswordChanged] = useState(false);

  const activate = async () => {
    const client = getSupabase();
    if (!client) { setError(t("notConfigured")); return; }
    if (newPassword.length < 12 || newPassword === temporaryPassword) return;
    setBusy(true); setError("");
    let didChange = false;
    try {
      const { data, error: signInError } = await client.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: temporaryPassword });
      if (signInError || !data.session) throw new Error("sign_in");
      const response = await fetch("/api/access/change-password", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify({ password: newPassword }), cache: "no-store" });
      if (!response.ok) throw new Error("change");
      didChange = true;
      setPasswordChanged(true);
      await recoverFromCloud(email, newPassword);
      router.replace("/");
    } catch (e) {
      setError(t(didChange ? "changedButRecoverFailed" : e instanceof Error && e.message === "sign_in" ? "wrongTemporary" : "failed"));
    } finally { setBusy(false); }
  };

  return <main className="page-enter mx-auto min-h-dvh max-w-[520px] space-y-6 px-5 py-7">
    <div className="flex items-center justify-between gap-3"><Wordmark size="sm" sub={false} /><LangToggle /></div>
    <header><h1 className="font-brand text-3xl font-bold">{t("title")}</h1><p className="mt-2 text-lg text-ink-soft">{t("intro")}</p></header>
    <form className="card space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void activate(); }}>
      <label className="block"><span className="label">{t("email")}</span><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="block"><span className="label">{t("temporaryPassword")}</span><input className="input" type="password" autoComplete="current-password" required value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)} /></label>
      <label className="block"><span className="label">{t("newPassword")}</span><input className="input" type="password" autoComplete="new-password" required minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label>
      <p className="text-sm text-ink-soft">{t("passwordHint")}</p>
      {error && <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}
      {passwordChanged && <Link className="btn btn-ghost w-full" href="/login">{t("goToLogin")}</Link>}
      <button className="btn btn-primary w-full text-lg" type="submit" disabled={busy || passwordChanged || !email || !temporaryPassword || newPassword.length < 12 || newPassword === temporaryPassword}>{busy ? t("working") : t("activate")}</button>
    </form>
    <Link href="/login" className="btn btn-ghost w-full">← {t("back")}</Link>
  </main>;
}
