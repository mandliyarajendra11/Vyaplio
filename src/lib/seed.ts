import { v4 as uuid } from "uuid";
import { planSuppliers } from "./supplierMigrate";
import { db, shopTables, type Basket, type Customer, type LedgerEntry, type Product, type Sale, type Shop, type StockMove, type Unit } from "./db";
import { DAY_MS, dayKey, isoDate, startOfDayMs } from "./dates";
import { round2 } from "./money";
import { kindForUnit, lineTotal } from "./units";

export const DEMO_SHOP_ID = "demo-shop";

type P = [nameHi: string, nameEn: string, unit: Unit, qty: number, buy: number, sell: number, low: number, expiryInDays: number | null, lastSoldDaysAgo: number, barcode?: string, supplier?: string];

const PRODUCTS: P[] = [
  ["चीनी", "Sugar", "kg", 3, 40, 45, 10, null, 0, undefined, "गुप्ता ट्रेडर्स"],
  ["आशीर्वाद आटा 5 किलो", "Aashirvaad Atta 5kg", "pkt", 14, 230, 255, 5, 90, 0, "8901725181222", "गुप्ता ट्रेडर्स"],
  ["बासमती चावल", "Basmati Rice", "kg", 22, 80, 95, 10, null, 1],
  ["अरहर दाल", "Toor Dal", "kg", 4, 130, 150, 8, null, 0, undefined, "गुप्ता ट्रेडर्स"],
  ["सरसों तेल 1 लीटर", "Mustard Oil 1L", "ltr", 9, 150, 170, 6, 120, 1],
  ["पारले-जी बिस्कुट", "Parle-G Biscuit", "pcs", 48, 4.5, 5, 24, 60, 0, "8901719110016"],
  ["अमूल दूध 500ml", "Amul Milk 500ml", "pkt", 6, 27, 30, 10, 1, 0, "8901262010015", "अमूल डेयरी"],
  ["ब्रेड", "Bread", "pkt", 5, 35, 40, 4, 2, 0],
  ["मैगी नूडल्स", "Maggi Noodles", "pcs", 60, 13, 14, 20, 150, 0, "8901058000290"],
  ["टाटा नमक", "Tata Salt", "pkt", 25, 25, 28, 10, null, 2, "8904043901015"],
  ["लाल मिर्च पाउडर", "Red Chilli Powder", "pkt", 12, 35, 45, 5, 200, 3],
  ["हल्दी पाउडर", "Turmeric Powder", "pkt", 10, 30, 40, 5, 200, 4],
  ["टाटा चाय पत्ती", "Tata Tea", "pkt", 15, 120, 135, 6, 180, 0, "8901052002019"],
  ["लक्स साबुन", "Lux Soap", "pcs", 30, 28, 32, 10, null, 1, "8901030865237"],
  ["सर्फ़ एक्सेल 1 किलो", "Surf Excel 1kg", "pkt", 2, 120, 135, 5, null, 2],
  ["दही 400 ग्राम", "Curd 400g", "pkt", 4, 32, 36, 3, -1, 1, undefined, "अमूल डेयरी"],
  ["कोलगेट टूथपेस्ट", "Colgate Toothpaste", "pcs", 18, 48, 55, 6, 300, 2, "8901314010209"],
  ["माचिस", "Matchbox", "pcs", 80, 1, 2, 20, null, 0],
  ["बेसन", "Besan (Gram Flour)", "kg", 7, 70, 85, 3, 6, 3],
  ["साबूदाना", "Sabudana", "kg", 8, 65, 80, 2, null, 52],
  ["नारियल तेल", "Coconut Oil", "pcs", 6, 95, 110, 2, 240, 41],
  ["मूंगफली", "Peanuts", "kg", 15, 110, 130, 3, null, 35],
];

type C = [name: string, phone: string, entries: [type: "debit" | "credit", amount: number, daysAgo: number, note?: string][]];
const CUSTOMERS: C[] = [
  ["रामू काका", "9876543210", [["debit", 650, 12, "राशन"], ["credit", 400, 6], ["debit", 200, 2, "तेल, चीनी"]]],
  ["सुनीता देवी", "9812345678", [["debit", 900, 20, "महीने का राशन"], ["debit", 300, 9], ["credit", 0, 0]]],
  ["मोहन लाल", "9900011122", [["debit", 500, 15], ["credit", 500, 3, "पूरा हिसाब"]]],
  ["गुड्डू भैया", "9988776655", [["debit", 320, 4, "बिस्कुट, मैगी"]]],
  ["शबनम बी", "9123456780", [["debit", 780, 25, "शादी का सामान"], ["credit", 200, 10]]],
  ["प्रकाश जी", "9765432109", [["debit", 150, 1]]],
];

/** Deterministic PRNG so the demo looks the same every time. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export async function seedDemo(ownerId: string) {
  const now = Date.now();
  const today = startOfDayMs(now);
  const rand = rng(42);

  const shop: Shop = {
    id: DEMO_SHOP_ID,
    ownerId,
    name: "शर्मा किराना स्टोर",
    ownerName: "रमेश शर्मा",
    phone: "9876500000",
    upiId: "sharmakirana@upi",
    language: "hi",
    deadStockDays: 30,
    expiryWarnDays: 7,
    isDemo: true,
    createdAt: now - 90 * DAY_MS,
    updatedAt: now,
  };

  const products: Product[] = PRODUCTS.map(([nameHi, nameEn, unit, qty, buy, sell, low, exp, lastSold, barcode, supplier], i) => ({
    id: `demo-p${i + 1}`,
    shopId: shop.id,
    nameHi,
    nameEn,
    unit,
    kind: kindForUnit(unit),
    qty,
    buyPrice: buy,
    sellPrice: sell,
    lowStockAt: low,
    expiryDate: exp === null ? undefined : isoDate(now + exp * DAY_MS),
    barcode,
    supplier,
    lastSoldAt: now - lastSold * DAY_MS - Math.floor(rand() * 3) * 3_600_000,
    salesCount: lastSold > 20 ? 1 : Math.floor(rand() * 40) + 5,
    createdAt: now - 80 * DAY_MS,
    updatedAt: now,
  }));

  const customers: Customer[] = [];
  const ledger: LedgerEntry[] = [];
  CUSTOMERS.forEach(([name, phone, entries], i) => {
    const id = `demo-c${i + 1}`;
    let balance = 0;
    let lastPaidAt: number | undefined;
    for (const [type, amount, daysAgo, note] of entries) {
      if (amount <= 0) continue;
      const at = today - daysAgo * DAY_MS + 10 * 3_600_000 + Math.floor(rand() * 8) * 3_600_000;
      ledger.push({ id: uuid(), shopId: shop.id, customerId: id, type, amount, note, createdAt: Math.min(at, now - 60_000) });
      balance += type === "debit" ? amount : -amount;
      if (type === "credit") lastPaidAt = at;
    }
    customers.push({ id, shopId: shop.id, name, phone, balance, lastPaidAt, createdAt: now - 60 * DAY_MS, updatedAt: now });
  });

  // Sales history: today + previous 6 days (cash / UPI). Fast movers only.
  const movers = products.filter((p) => (now - (p.lastSoldAt ?? 0)) / DAY_MS < 20);
  const sales: Sale[] = [];
  for (let d = 6; d >= 0; d--) {
    const count = d === 0 ? 7 : 5 + Math.floor(rand() * 6);
    for (let k = 0; k < count; k++) {
      const at =
        d === 0
          ? now - (count - k) * 22 * 60_000
          : today - d * DAY_MS + (8 + Math.floor(rand() * 12)) * 3_600_000 + Math.floor(rand() * 59) * 60_000;
      const n = 1 + Math.floor(rand() * 3);
      const items = Array.from({ length: n }, () => {
        const p = movers[Math.floor(rand() * movers.length)];
        const qty = p.unit === "pcs" ? 1 + Math.floor(rand() * 4) : 1;
        return { productId: p.id, nameHi: p.nameHi, nameEn: p.nameEn, unit: p.unit, qty, price: p.sellPrice, cost: p.buyPrice };
      });
      sales.push({
        id: uuid(),
        shopId: shop.id,
        items,
        total: round2(items.reduce((s, i) => s + lineTotal(i), 0)),
        cost: round2(items.reduce((s, i) => s + i.qty * i.cost, 0)),
        payment: rand() < 0.4 ? "upi" : "cash",
        createdAt: at,
        day: dayKey(at),
      });
    }
  }
  // One credit sale today for Guddu, matched in his ledger.
  const guddu = customers[3];
  const credItems = [
    { productId: products[5].id, nameHi: products[5].nameHi, nameEn: products[5].nameEn, unit: products[5].unit, qty: 4, price: 5, cost: 4.5 },
    { productId: products[8].id, nameHi: products[8].nameHi, nameEn: products[8].nameEn, unit: products[8].unit, qty: 2, price: 14, cost: 13 },
  ];
  const credAt = now - 40 * 60_000;
  const credSale: Sale = { id: uuid(), shopId: shop.id, items: credItems, total: 48, cost: 44, payment: "credit", customerId: guddu.id, createdAt: credAt, day: dayKey(credAt) };
  sales.push(credSale);
  ledger.push({ id: uuid(), shopId: shop.id, customerId: guddu.id, type: "debit", amount: 48, saleId: credSale.id, createdAt: credAt });
  guddu.balance += 48;
  // Repeat orders: Guddu's delivery address and a saved monthly basket.
  guddu.address = "गली नं. 3, शिव मंदिर रोड";
  guddu.landmark = "मंदिर के सामने";
  const basket: Basket = {
    id: "demo-basket-1",
    shopId: shop.id,
    customerId: guddu.id,
    name: "महीने का राशन",
    lines: [products[5], products[8]].map((p, i) => ({ productId: p.id, nameHi: p.nameHi, nameEn: p.nameEn, unit: p.unit, qty: i === 0 ? 4 : 2, price: p.sellPrice })),
    fromSaleId: credSale.id,
    createdAt: credAt,
    updatedAt: credAt,
  };

  // Stock = sum of moves: one opening move per product.
  const moves: StockMove[] = products.map((p) => ({ id: `open-${p.id}`, shopId: shop.id, productId: p.id, delta: p.qty, reason: "opening", createdAt: p.createdAt }));

  await db.transaction("rw", shopTables(), async () => {
    await db.saleDrafts.delete(shop.id);
    await Promise.all([
      db.products.where("shopId").equals(shop.id).delete(),
      db.customers.where("shopId").equals(shop.id).delete(),
      db.sales.where("shopId").equals(shop.id).delete(),
      db.ledger.where("shopId").equals(shop.id).delete(),
      db.corrections.where("shopId").equals(shop.id).delete(),
      db.stockMoves.where("shopId").equals(shop.id).delete(),
      db.cashEntries.where("shopId").equals(shop.id).delete(),
      db.suppliers.where("shopId").equals(shop.id).delete(),
      db.purchases.where("shopId").equals(shop.id).delete(),
      db.supplierLedger.where("shopId").equals(shop.id).delete(),
      db.orders.where("shopId").equals(shop.id).delete(),
      db.baskets.where("shopId").equals(shop.id).delete(),
      db.customerOrders.where("shopId").equals(shop.id).delete(),
      db.orderEvents.where("shopId").equals(shop.id).delete(),
      db.outbox.where("shopId").equals(shop.id).delete(),
    ]);
    await db.shops.put(shop);
    // Demo suppliers from the products' supplier names (7 days credit), products linked.
    const plan = planSuppliers(products, [], [], shop.createdAt);
    await db.suppliers.bulkPut(plan.created.map((s) => ({ ...s, termsDays: 7 })));
    const link = new Map(plan.links);
    await db.products.bulkPut(products.map((p) => (link.has(p.id) ? { ...p, supplierId: link.get(p.id) } : p)));
    await db.customers.bulkPut(customers);
    await db.sales.bulkPut(sales);
    await db.ledger.bulkPut(ledger);
    await db.stockMoves.bulkPut(moves);
    await db.baskets.put(basket);
  });
  return shop;
}
