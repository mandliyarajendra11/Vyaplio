import { randomBytes, randomUUID } from "node:crypto";
import { authorizedAdmin } from "@/lib/server/admin";

export async function GET(request: Request) {
  const gate = await authorizedAdmin(request);
  if ("error" in gate) return gate.error;
  const [access, shops, audit] = await Promise.all([
    gate.service.from("shop_access").select("shop_id,owner_id,email,plan,amount_paid,payment_reference,paid_at,expires_at,status,must_change_password").order("created_at", { ascending: false }).limit(500),
    gate.service.from("shops").select("id,name,owner_name,phone").limit(500),
    gate.service.from("shop_access_audit").select("id,shop_id,actor_id,event,occurred_at").order("id", { ascending: false }).limit(100),
  ]);
  if (access.error || shops.error || audit.error) return Response.json({ error: "read_failed" }, { status: 500 });
  const byId = new Map((shops.data ?? []).map((shop) => [shop.id, shop]));
  const rows = (access.data ?? []).map((item) => ({ ...item, shop: byId.get(item.shop_id) ?? null }));
  return Response.json({ shops: rows, audit: audit.data ?? [], now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const gate = await authorizedAdmin(request);
  if ("error" in gate) return gate.error;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: "invalid_input" }, { status: 400 }); }
  if (!raw || typeof raw !== "object") return Response.json({ error: "invalid_input" }, { status: 400 });
  const input = raw as Record<string, unknown>;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const shopName = typeof input.shopName === "string" ? input.shopName.trim() : "";
  const ownerName = typeof input.ownerName === "string" ? input.ownerName.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.replace(/\D/g, "") : "";
  const paymentReference = typeof input.paymentReference === "string" ? input.paymentReference.trim() : "";
  const plan = input.plan;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || shopName.length < 2 || shopName.length > 80 || ownerName.length > 80 || (phone && !/^\d{10}$/.test(phone)) || paymentReference.length < 4 || paymentReference.length > 80 || (plan !== "yearly" && plan !== "lifetime") || input.paymentVerified !== true) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
  // A payment reference must be unique even if a previous provisioning attempt failed midway.
  const { data: duplicate, error: lookupError } = await gate.service.from("shop_access").select("shop_id").eq("payment_reference", paymentReference).maybeSingle();
  if (lookupError) return Response.json({ error: "lookup_failed" }, { status: 500 });
  if (duplicate) return Response.json({ error: "payment_used" }, { status: 409 });

  const temporaryPassword = randomBytes(18).toString("base64url");
  const { data: created, error: createError } = await gate.service.auth.admin.createUser({ email, password: temporaryPassword, email_confirm: true });
  if (createError || !created.user) return Response.json({ error: "account_creation_failed" }, { status: 409 });
  const ownerId = created.user.id;
  const shopId = randomUUID();
  const paidAt = new Date();
  const expiresAt = new Date(paidAt);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  try {
    const { error: shopError } = await gate.service.from("shops").insert({ id: shopId, owner_id: ownerId, name: shopName, owner_name: ownerName || null, phone: phone || null, language: "hi", is_demo: false });
    if (shopError) throw shopError;
    const { error: accessError } = await gate.service.from("shop_access").insert({ shop_id: shopId, owner_id: ownerId, email, plan, amount_paid: plan === "yearly" ? 2999 : 11000, payment_reference: paymentReference, paid_at: paidAt.toISOString(), expires_at: plan === "yearly" ? expiresAt.toISOString() : null, must_change_password: true, created_by: gate.adminId });
    if (accessError) throw accessError;
  } catch {
    // Auth and Postgres are separate transactions. Remove partial provisioning on failure.
    await gate.service.from("shops").delete().eq("id", shopId);
    await gate.service.auth.admin.deleteUser(ownerId);
    return Response.json({ error: "provision_failed" }, { status: 500 });
  }
  return Response.json({ shopId, email, temporaryPassword }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
