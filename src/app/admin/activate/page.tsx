"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { getSupabase } from "@/lib/supabase/client";

export default function AdminActivatePage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async () => {
    setBusy(true); setError("");
    try {
      const client = getSupabase();
      const session = await client?.auth.getSession();
      if (!client || !session?.data.session) throw new Error("Sign in on the login page with your temporary admin password first.");
      const response = await fetch("/api/admin/change-password", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.data.session.access_token}` }, body: JSON.stringify({ currentPassword, password }), cache: "no-store" });
      if (!response.ok) throw new Error("Could not change the password. Ask for help if the temporary password has already been used.");
      router.replace("/admin");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change password."); }
    finally { setBusy(false); }
  };
  return <main className="page-enter mx-auto min-h-dvh max-w-[500px] space-y-6 px-5 py-7">
    <Wordmark size="sm" sub={false} />
    <header><h1 className="font-brand text-3xl font-bold">Set your admin password</h1><p className="mt-2 text-lg text-ink-soft">Your temporary password opens this step only. Choose a new password before accessing customer accounts.</p></header>
    <form className="card space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void change(); }}>
      <label className="block"><span className="label">Temporary password</span><input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
      <label className="block"><span className="label">New password</span><input className="input" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label className="block"><span className="label">Confirm new password</span><input className="input" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      <p className="text-sm text-ink-soft">Use at least 12 characters. Keep it private.</p>
      {error && <p role="alert" className="font-semibold text-brick">{error}</p>}
      <button className="btn btn-primary w-full" disabled={busy || !currentPassword || password.length < 12 || password === currentPassword || password !== confirm}>{busy ? "Saving…" : "Save password and open admin"}</button>
    </form>
  </main>;
}
