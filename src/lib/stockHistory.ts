import { fmtDate } from "./dates";
import type { Product, StockMove } from "./db";
import { round2 } from "./money";

/** Stock history (incl. shortages and reasoned corrections) as CSV rows for Excel. */
export const STOCK_MOVES_CSV_HEADERS = [
  "date",
  "product_hi",
  "product_en",
  "unit",
  "reason",
  "change",
  "short_by",
  "counted",
  "note",
  "ref_id",
  "value_at_buy_price",
];

export function stockMovesCSVRows(moves: StockMove[], products: Pick<Product, "id" | "nameHi" | "nameEn" | "unit" | "buyPrice">[]) {
  const byId = new Map(products.map((p) => [p.id, p]));
  return moves
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map((m) => {
      const p = byId.get(m.productId);
      return [
        fmtDate(m.createdAt, "en", "yyyy-MM-dd HH:mm"),
        p?.nameHi ?? m.productId,
        p?.nameEn ?? "",
        p?.unit ?? "",
        m.reason,
        m.delta,
        m.shortBy ?? "",
        m.counted ?? "",
        m.note ?? "",
        m.refId ?? "",
        p ? round2(m.delta * p.buyPrice) : "",
      ];
    });
}
