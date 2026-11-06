import { AppShell } from "@/components/AppShell";

// Client-rendered from IndexedDB (session + shop are browser-only), so this segment is not part of the static shell.
export const instant = false;

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
