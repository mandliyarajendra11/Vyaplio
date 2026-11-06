import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Vyaplio — व्याप्लियो",
    short_name: "Vyaplio",
    description: "दुकान का हिसाब फ़ोन पर — बिक्री, स्टॉक, उधार, अलर्ट",
    lang: "hi",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5ecd7",
    theme_color: "#0e5a5e",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "बिक्री · Sale", url: "/sale", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "उधार · Udhaar", url: "/udhaar", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
