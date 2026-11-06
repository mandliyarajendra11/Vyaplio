import { createClient } from "@supabase/supabase-js";

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function verifyAdmin(service: NonNullable<ReturnType<typeof serviceClient>>, request: Request): Promise<{ error: Response } | { adminId: string }> {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) } as const;
  const { data: auth, error: authError } = await service.auth.getUser(match[1]);
  if (authError || !auth.user) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) } as const;
  const { data: admin, error: roleError } = await service.from("admin_users").select("user_id,must_change_password").eq("user_id", auth.user.id).maybeSingle();
  if (roleError) return { error: Response.json({ error: "admin_setup_required" }, { status: 503 }) } as const;
  if (!admin) return { error: Response.json({ error: "forbidden" }, { status: 403 }) } as const;
  if (admin.must_change_password) return { error: Response.json({ error: "password_change_required" }, { status: 428 }) } as const;
  return { adminId: auth.user.id } as const;
}

export async function authorizedAdmin(request: Request) {
  const service = serviceClient();
  if (!service) return { error: Response.json({ error: "not_configured" }, { status: 503 }) } as const;
  const gate = await verifyAdmin(service, request);
  if ("error" in gate) return { error: gate.error };
  return { service, adminId: gate.adminId } as const;
}
