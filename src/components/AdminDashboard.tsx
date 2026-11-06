"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { getSupabase } from "@/lib/supabase/client";
import { formatINR } from "@/lib/money";

type Row = {
  shop_id: string; owner_id?: string; email: string; plan: "yearly" | "lifetime" | "legacy"; amount_paid: number;
  paid_at: string | null; expires_at: string | null; status: string; must_change_password: boolean;
  shop: { name: string; owner_name: string | null; phone: string | null } | null;
};
type Audit = { id: number; shop_id: string; actor_id: string; event: "created" | "activated" | "renewed" | "disabled" | "enabled"; occurred_at: string };

export default function AdminPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [serverNow, setServerNow] = useState(0);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [form, setForm] = useState({ email: "", shopName: "", ownerName: "", phone: "", plan: "yearly", paymentReference: "", paymentVerified: false });

  const load = useCallback(async (accessToken: string) => {
    const response = await fetch("/api/admin/shops", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (response.status === 428) { router.replace("/admin/activate"); return; }
    if (!response.ok) throw new Error(response.status === 403 ? "This account is not an admin. Add its Auth user ID to admin_users." : "Admin setup is unavailable. Check the Supabase configuration and migration.");
    const data = await response.json() as { shops: Row[]; audit: Audit[]; now: number };
    setRows(data.shops);
    setAudit(data.audit);
    setServerNow(data.now);
    setToken(accessToken);
  }, [router]);

  useEffect(() => {
    let live = true;
    const client = getSupabase();
    if (!client) return;
    void client.auth.getSession().then(async ({ data }) => {
      if (!live || !data.session) return;
      try { await load(data.session.access_token); } catch (e) { if (live) setError(e instanceof Error ? e.message : "Could not load admin access."); }
    });
    return () => { live = false; };
  }, [load]);

  const signIn = async () => {
    const client = getSupabase();
    if (!client) { setError("Configure Supabase before using admin access."); return; }
    setBusy(true); setError("");
    try {
      const { data, error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (authError || !data.session) throw new Error("Wrong email or password.");
      await load(data.session.access_token);
      setPassword("");
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };

  const provision = async () => {
    if (!token) return;
    setBusy(true); setError(""); setCreated(null);
    try {
      const session = await getSupabase()?.auth.getSession();
      const currentToken = session?.data.session?.access_token;
      if (!currentToken) throw new Error("Your admin session expired. Sign in again.");
      const response = await fetch("/api/admin/shops", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentToken}` }, body: JSON.stringify(form), cache: "no-store" });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error === "payment_used" ? "This payment reference is already used." : body.error === "account_creation_failed" ? "This email may already have an account. Check before retrying." : "Shop creation failed. No account was issued; check the server and retry.");
      }
      const result = await response.json() as { email: string; temporaryPassword: string };
      setCreated(result);
      setForm({ email: "", shopName: "", ownerName: "", phone: "", plan: "yearly", paymentReference: "", paymentVerified: false });
      await load(currentToken);
    } catch (e) { setError(e instanceof Error ? e.message : "Shop creation failed."); }
    finally { setBusy(false); }
  };

  const revenue = rows.reduce((sum, row) => sum + (row.plan === "legacy" ? 0 : row.amount_paid), 0);
  const dueSoon = rows.filter((row) => row.plan === "yearly" && row.expires_at && new Date(row.expires_at).getTime() <= serverNow + 30 * 86400000).length;

  return <main className="page-enter mx-auto min-h-dvh max-w-[1000px] space-y-6 px-5 py-7 lg:px-10">
    <div className="flex items-center justify-between gap-3"><Wordmark size="sm" sub={false} /><span className="font-bold">Admin</span></div>
    {!token ? <form className="card mx-auto max-w-[460px] space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
      <h1 className="font-brand text-2xl font-bold">Admin sign-in</h1>
      <label className="block"><span className="label">Email</span><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="block"><span className="label">Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      {error && <p role="alert" className="font-semibold text-brick">{error}</p>}
    </form> : <>
      <div className="flex items-center justify-between gap-3"><h1 className="font-brand text-3xl font-bold">Paid shops</h1><button type="button" className="btn btn-ghost" onClick={async () => { await getSupabase()?.auth.signOut(); setToken(null); setRows([]); setCreated(null); }}>Sign out</button></div>
      <div className="grid gap-3 sm:grid-cols-3"><div className="card p-4"><p className="text-ink-soft">Shops</p><p className="num text-3xl font-bold">{rows.length}</p></div><div className="card p-4"><p className="text-ink-soft">Payments recorded</p><p className="num text-3xl font-bold">{formatINR(revenue)}</p></div><div className="card p-4"><p className="text-ink-soft">Yearly due within 30 days</p><p className="num text-3xl font-bold">{dueSoon}</p></div></div>
      <form className="card space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void provision(); }}>
        <h2 className="text-2xl font-bold">Create a paid shop</h2><p className="text-ink-soft">Confirm the payment in your bank or Razorpay dashboard before issuing an account.</p>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="label">Customer email</span><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label className="block"><span className="label">Shop name</span><input className="input" required minLength={2} value={form.shopName} onChange={(e) => setForm({ ...form, shopName: e.target.value })} /></label><label className="block"><span className="label">Owner name</span><input className="input" value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} /></label><label className="block"><span className="label">Mobile number</span><input className="input num" type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label><label className="block"><span className="label">Plan</span><select className="input" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}><option value="yearly">Yearly · ₹2,999</option><option value="lifetime">Lifetime · ₹11,000</option></select></label><label className="block"><span className="label">Payment reference / UTR</span><input className="input" required minLength={4} value={form.paymentReference} onChange={(e) => setForm({ ...form, paymentReference: e.target.value })} /></label></div>
        <label className="flex items-center gap-3 font-semibold"><input type="checkbox" className="h-6 w-6 accent-teal" checked={form.paymentVerified} onChange={(e) => setForm({ ...form, paymentVerified: e.target.checked })} />I verified that this payment reached my account.</label>
        <button className="btn btn-primary w-full sm:w-auto" disabled={busy || !form.paymentVerified}>{busy ? "Creating…" : "Create account and shop"}</button>
      </form>
      {created && <section className="card space-y-2 border-2 border-teal p-5" role="status"><h2 className="text-xl font-bold">Account created</h2><p>{created.email}</p><p className="font-semibold">Temporary password: <span className="num select-all">{created.temporaryPassword}</span></p><p>Give this to the owner privately with the <a className="font-bold text-teal underline" href="/activate">activation page</a>. The password is shown only now. They must change it before their shop opens.</p><button type="button" className="btn btn-ghost" onClick={() => setCreated(null)}>Hide password</button></section>}
      {error && <p role="alert" className="rounded-xl bg-brick/10 p-4 font-semibold text-brick">{error}</p>}
      <section className="card p-5"><h2 className="mb-4 text-xl font-bold">Shops</h2>{rows.length ? <ul className="divide-y divide-line">{rows.map((row) => <li key={row.shop_id} className="py-3"><p className="font-bold">{row.shop?.name ?? row.shop_id}</p><p className="text-sm text-ink-soft">{row.email} · {row.plan} · {row.status}{row.must_change_password ? " · awaiting first password change" : ""}</p>{row.expires_at && <p className="text-sm">Expires {new Date(row.expires_at).toLocaleDateString("en-IN")}</p>}</li>)}</ul> : <p className="text-ink-soft">No shops yet.</p>}</section>
      <section className="card p-5"><h2 className="mb-2 text-xl font-bold">Account history</h2><p className="text-sm text-ink-soft">Most recent 100 account actions. Older actions remain in the database.</p>{audit.length ? <ul className="mt-3 divide-y divide-line">{audit.map((item) => { const shop = rows.find((row) => row.shop_id === item.shop_id); return <li key={item.id} className="py-3"><p className="font-bold capitalize">{item.event} · {shop?.shop?.name ?? item.shop_id}</p><p className="text-sm text-ink-soft">{item.actor_id === shop?.owner_id ? "Shop owner" : "Admin"} · {new Date(item.occurred_at).toLocaleString("en-IN")}</p></li>; })}</ul> : <p className="mt-3 text-ink-soft">No account actions recorded yet.</p>}</section>
    </>}
  </main>;
}
