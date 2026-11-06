"use client";

import { NextIntlClientProvider } from "next-intl";
import { useEffect } from "react";
import { Splash } from "@/components/Splash";
import { initInstallPrompt } from "@/lib/install";
import { useLocalePref, useMounted } from "@/lib/hooks";
import { initOffline } from "@/lib/offline";
import { startAutoSync } from "@/lib/sync";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";

/**
 * Everything is local-first (IndexedDB), so the app renders only in the browser.
 * The prerendered HTML is a branded splash – which is also what the service worker caches.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  const mounted = useMounted();
  const locale = useLocalePref();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    initInstallPrompt();
    initOffline();
    return startAutoSync();
  }, []);

  if (!mounted) return <Splash />;

  return (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="Asia/Kolkata">
      {children}
    </NextIntlClientProvider>
  );
}
