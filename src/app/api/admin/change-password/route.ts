import { createClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/server/admin";

export async function POST(request: Request) {
  const service = serviceClient();
  if (!service) return Response.json({ error: "not_configured" }, { status: 503 });
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { data: auth, error: authError } = await service.auth.getUser(match[1]);
  if (authError || !auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid_input" }, { status: 400 }); }
  const password = body && typeof body === "object" && "password" in body ? (body as { password: unknown }).password : null;
  const currentPassword = body && typeof body === "object" && "currentPassword" in body ? (body as { currentPassword: unknown }).currentPassword : null;
  if (typeof password !== "string" || password.length < 12 || password.length > 128 || typeof currentPassword !== "string" || !currentPassword || password === currentPassword) return Response.json({ error: "invalid_input" }, { status: 400 });
  const { data: admin, error: roleError } = await service.from("admin_users").select("user_id,must_change_password").eq("user_id", auth.user.id).maybeSingle();
  if (roleError || !admin || !admin.must_change_password) return Response.json({ error: "not_pending" }, { status: 403 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return Response.json({ error: "not_configured" }, { status: 503 });
  const verifyClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: verified, error: verifyError } = await verifyClient.auth.signInWithPassword({ email: auth.user.email ?? "", password: currentPassword });
  if (verifyError || verified.user?.id !== auth.user.id) return Response.json({ error: "wrong_current_password" }, { status: 403 });
  const { error: passwordError } = await service.auth.admin.updateUserById(auth.user.id, { password });
  if (passwordError) return Response.json({ error: "change_failed" }, { status: 500 });
  const { error: updateError } = await service.from("admin_users").update({ must_change_password: false }).eq("user_id", auth.user.id).eq("must_change_password", true);
  if (updateError) return Response.json({ error: "activation_failed" }, { status: 500 });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
