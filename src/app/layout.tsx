import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope, Mukta } from "next/font/google";
import Providers from "./providers";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "opsz"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

const mukta = Mukta({
  variable: "--font-mukta",
  subsets: ["devanagari", "latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vyaplio · व्याप्लियो — Billing & Inventory for Shops",
  description: "दुकान का हिसाब फ़ोन पर — बिक्री, स्टॉक, उधार और अलर्ट। Billing, inventory and daily shop management for retailers.",
  applicationName: "Vyaplio",
  appleWebApp: { capable: true, title: "Vyaplio", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

/**
 * Local-first app: every screen reads IndexedDB in the browser, so the server shell is a branded
 * splash and client-rendered segments are expected. Opt out of instant-navigation validation.
 */
export const instant = false;

export const viewport: Viewport = {
  themeColor: "#0e5a5e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android Chrome: the on-screen keyboard shrinks the layout viewport, so bottom sheets (fixed,
  // bottom-anchored, max 94dvh) sit above the keyboard instead of under it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hi" className={`${fraunces.variable} ${manrope.variable} ${mukta.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
