import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AdminPreview } from "@/components/AdminPreview";

export default async function DevAdminPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const host = (await headers()).get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) notFound();
  return <AdminPreview />;
}
