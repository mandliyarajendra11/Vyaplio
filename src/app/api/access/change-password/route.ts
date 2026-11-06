import { randomUUID } from "node:crypto";
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
  if (typeof password !== "string" || password.length < 12 || password.length > 128) return Response.json({ error: "invalid_input" }, { status: 400 });
  const { data: access, error: accessError } = await service.from("shop_access").select("shop_id,must_change_password,status").eq("owner_id", auth.user.id).maybeSingle();
  if (accessError || !access || access.status !== "active" || !access.must_change_password) return Response.json({ error: "not_pending" }, { status: 403 });
  const { error: changeError } = await service.auth.admin.updateUserById(auth.user.id, { password });
  if (changeError) return Response.json({ error: "change_failed" }, { status: 500 });
  const { data: updated, error: updateError } = await service.from("shop_access")
    .update({ must_change_password: false, last_action_by: auth.user.id, last_action_id: randomUUID() })
    .eq("owner_id", auth.user.id).eq("must_change_password", true).select("shop_id").maybeSingle();
  if (updateError || !updated) return Response.json({ error: "activation_failed" }, { status: 500 });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
