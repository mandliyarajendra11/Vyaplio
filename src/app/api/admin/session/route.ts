import { authorizedAdmin } from "@/lib/server/admin";

export async function GET(request: Request) {
  const gate = await authorizedAdmin(request);
  if ("error" in gate) return gate.error;
  return Response.json({ admin: true }, { headers: { "Cache-Control": "no-store" } });
}
