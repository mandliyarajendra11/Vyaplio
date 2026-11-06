/**
 * Starter product lists for assisted setup, picked from the built-in alias catalogue
 * (aliases.ts) so every item already answers to its Hindi / English / Roman names in search.
 * The shopkeeper ticks what they stock; price and opening quantity are optional (0 = fill later).
 */
import { KIRANA_ALIASES } from "./aliases";
import type { Unit } from "./db";
import type { ProductInput } from "./ops";

export const SHOP_TYPES = ["kirana", "general", "dairy", "medical", "stationery", "sabzi", "other"] as const;
export type ShopType = (typeof SHOP_TYPES)[number];

/** [Hindi name = catalogue entry head, English name, typical unit, low-stock level] */
export type StarterItem = readonly [nameHi: string, nameEn: string, unit: Unit, lowStockAt: number];

const I = (nameHi: string, nameEn: string, unit: Unit, low: number): StarterItem => [nameHi, nameEn, unit, low];

export const STARTER: Record<ShopType, readonly StarterItem[]> = {
  kirana: [
    I("चीनी", "Sugar", "kg", 10), I("नमक", "Salt", "pkt", 10), I("आटा", "Atta", "kg", 10), I("चावल", "Rice", "kg", 10),
    I("अरहर दाल", "Toor Dal", "kg", 5), I("मूंग दाल", "Moong Dal", "kg", 5), I("चना दाल", "Chana Dal", "kg", 5),
    I("बेसन", "Besan", "kg", 3), I("सूजी", "Suji", "kg", 3), I("पोहा", "Poha", "kg", 3),
    I("सरसों तेल", "Mustard Oil", "ltr", 5), I("रिफाइंड तेल", "Refined Oil", "ltr", 5), I("घी", "Ghee", "pkt", 3),
    I("हल्दी", "Turmeric", "pkt", 5), I("मिर्च", "Chilli Powder", "pkt", 5), I("धनिया", "Coriander Powder", "pkt", 5),
    I("जीरा", "Cumin", "pkt", 5), I("गरम मसाला", "Garam Masala", "pkt", 5), I("चाय पत्ती", "Tea", "pkt", 5),
    I("गुड़", "Jaggery", "kg", 3), I("बिस्कुट", "Biscuit", "pcs", 20), I("मैगी", "Maggi", "pcs", 20),
    I("नमकीन", "Namkeen", "pkt", 10), I("साबुन", "Soap", "pcs", 10), I("सर्फ़", "Detergent Powder", "pkt", 5),
    I("टूथपेस्ट", "Toothpaste", "pcs", 5), I("माचिस", "Matchbox", "pcs", 20), I("अगरबत्ती", "Agarbatti", "pkt", 10),
  ],
  general: [
    I("साबुन", "Soap", "pcs", 10), I("शैम्पू", "Shampoo", "pcs", 10), I("टूथपेस्ट", "Toothpaste", "pcs", 5),
    I("टूथब्रश", "Toothbrush", "pcs", 5), I("सर्फ़", "Detergent Powder", "pkt", 5), I("कपड़े धोने का साबुन", "Washing Soap", "pcs", 10),
    I("बर्तन साबुन", "Dishwash Bar", "pcs", 10), I("फिनाइल", "Phenyl", "ltr", 3), I("बिस्कुट", "Biscuit", "pcs", 20),
    I("चिप्स", "Chips", "pkt", 10), I("कोल्ड ड्रिंक", "Cold Drink", "pcs", 12), I("पानी की बोतल", "Water Bottle", "pcs", 12),
    I("चॉकलेट", "Chocolate", "pcs", 20), I("बल्ब", "Bulb", "pcs", 5), I("बैटरी", "Battery", "pcs", 10),
    I("मोमबत्ती", "Candle", "pkt", 5), I("माचिस", "Matchbox", "pcs", 20), I("अगरबत्ती", "Agarbatti", "pkt", 10),
    I("झाड़ू", "Broom", "pcs", 3), I("क्रीम", "Cream", "pcs", 5), I("पाउडर", "Talc Powder", "pcs", 5),
    I("सैनिटरी पैड", "Sanitary Pads", "pkt", 5), I("डायपर", "Diapers", "pkt", 3), I("मच्छर अगरबत्ती", "Mosquito Coil", "pkt", 5),
    I("थैली", "Carry Bag", "pcs", 50),
  ],
  dairy: [
    I("दूध", "Milk", "ltr", 10), I("दही", "Curd", "kg", 3), I("पनीर", "Paneer", "kg", 2), I("मक्खन", "Butter", "pkt", 5),
    I("घी", "Ghee", "pkt", 3), I("छाछ", "Buttermilk", "ltr", 5), I("लस्सी", "Lassi", "pcs", 10), I("खोया", "Khoya", "kg", 1),
    I("आइसक्रीम", "Ice Cream", "pcs", 10), I("अंडे", "Eggs", "pcs", 30), I("ब्रेड", "Bread", "pkt", 5), I("शहद", "Honey", "pcs", 3),
  ],
  medical: [
    I("बुखार की गोली", "Paracetamol", "pkt", 10), I("दर्द की गोली", "Pain Reliever", "pkt", 5), I("खांसी की दवा", "Cough Syrup", "pcs", 5),
    I("ओआरएस", "ORS", "pkt", 10), I("बैंडेज", "Bandage", "box", 3), I("रुई", "Cotton", "pkt", 5), I("डेटॉल", "Antiseptic Liquid", "pcs", 3),
    I("बाम", "Pain Balm", "pcs", 5), I("गैस की दवा", "Antacid", "pkt", 5), I("विटामिन", "Vitamins", "box", 3),
    I("थर्मामीटर", "Thermometer", "pcs", 2), I("मास्क", "Face Mask", "pcs", 20), I("सैनिटाइज़र", "Sanitizer", "pcs", 5),
    I("सैनिटरी पैड", "Sanitary Pads", "pkt", 5), I("डायपर", "Diapers", "pkt", 3),
  ],
  stationery: [
    I("कॉपी", "Notebook", "pcs", 20), I("पेन", "Pen", "pcs", 20), I("पेंसिल", "Pencil", "pcs", 20), I("रबर", "Eraser", "pcs", 10),
    I("स्केल", "Scale", "pcs", 5), I("गोंद", "Glue", "pcs", 5), I("रजिस्टर", "Register", "pcs", 5), I("लिफ़ाफ़ा", "Envelope", "pcs", 20),
    I("बैटरी", "Battery", "pcs", 10), I("चॉकलेट", "Chocolate", "pcs", 20),
  ],
  sabzi: [
    I("आलू", "Potato", "kg", 10), I("प्याज़", "Onion", "kg", 10), I("टमाटर", "Tomato", "kg", 5), I("लहसुन", "Garlic", "kg", 1),
    I("अदरक", "Ginger", "kg", 1), I("हरी मिर्च", "Green Chilli", "kg", 1), I("नींबू", "Lemon", "pcs", 20), I("भिंडी", "Okra", "kg", 2),
    I("फूल गोभी", "Cauliflower", "pcs", 5), I("पत्ता गोभी", "Cabbage", "pcs", 5), I("बैंगन", "Brinjal", "kg", 2), I("गाजर", "Carrot", "kg", 2),
    I("खीरा", "Cucumber", "kg", 2), I("केला", "Banana", "pcs", 12), I("सेब", "Apple", "kg", 2),
  ],
  other: [],
};

export const isShopType = (v: unknown): v is ShopType => typeof v === "string" && (SHOP_TYPES as readonly string[]).includes(v);

export const starterFor = (type: ShopType | undefined) => (type ? STARTER[type] : []);

/** True when every starter item is a head entry of the alias catalogue. */
export function starterCatalogueGaps(): string[] {
  const heads = new Set(KIRANA_ALIASES.map((e) => e[0]));
  return SHOP_TYPES.flatMap((t) => STARTER[t].filter(([hi]) => !heads.has(hi)).map(([hi]) => `${t}:${hi}`));
}

export interface PickedItem {
  /** Optional, may be blank: fill later from the stock screen. */
  price?: number;
  qty?: number;
}

/** Products to create for the ticked starter items (price / quantity default to 0). */
export function starterProducts(type: ShopType | undefined, picked: Record<string, PickedItem>): ProductInput[] {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0);
  return starterFor(type)
    .filter(([hi]) => picked[hi])
    .map(([nameHi, nameEn, unit, lowStockAt]) => ({
      nameHi,
      nameEn,
      unit,
      qty: n(picked[nameHi].qty),
      buyPrice: 0,
      sellPrice: n(picked[nameHi].price),
      lowStockAt,
    }));
}
