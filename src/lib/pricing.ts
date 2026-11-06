export const PLANS = [
  { id: "yearly", rupees: 2999, period: "year" },
  { id: "lifetime", rupees: 11000, period: "once" },
] as const;

export type PlanId = (typeof PLANS)[number]["id"];
export const planById = (id: PlanId) => PLANS.find((p) => p.id === id)!;

/** Public sales contact supplied by the seller. */
export const DEFAULT_SALES_WHATSAPP = "919993904447";

/** Build a contact link only for a configured seller number; never send buyers to an unknown recipient. */
export function salesWhatsAppNumber(value?: string): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

export function planEnquiry(id: PlanId, language: "en" | "hi") {
  const price = id === "yearly" ? language === "hi" ? "₹2,999 साल में" : "₹2,999/year" : language === "hi" ? "₹11,000 एक बार" : "₹11,000 lifetime";
  return language === "hi"
    ? `नमस्ते, मुझे Vyaplio का ${id === "yearly" ? "सालाना" : "लाइफ़टाइम"} प्लान (${price}) चाहिए। कृपया खरीदने का तरीका बताइए।`
    : `Hello, I'm interested in the Vyaplio ${id === "yearly" ? "yearly" : "lifetime"} plan (${price}). Please tell me how to purchase it.`;
}
