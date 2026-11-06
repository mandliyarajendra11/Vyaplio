"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { db, type Locale, type Product } from "@/lib/db";
import { formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { quickSetProduct } from "@/lib/ops";
import { parseDecimal } from "@/lib/productImport";
import { validAmount, validQtyFor } from "@/lib/units";
import { Sheet } from "./Sheet";

export function QuickProductSheet({ shopId, product, onClose, onSaved, onDetails }: { shopId: string; product: Product; onClose: () => void; onSaved: (message: string) => void; onDetails: (product: Product) => void }) {
  const t = useTranslations();
  const tq = useTranslations("quickProduct");
  const locale = useLocale() as Locale;
  const live = useLiveQuery(() => db.products.get(product.id), [product.id]) ?? product;
  const [sell, setSell] = useState(String(product.sellPrice));
  const [buy, setBuy] = useState(product.buyPrice ? String(product.buyPrice) : "");
  const [qty, setQty] = useState(String(product.qty));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sellValue = parseDecimal(sell), buyValue = buy.trim() ? parseDecimal(buy) : 0, qtyValue = parseDecimal(qty);
  const valid = validAmount(sellValue) && Number.isFinite(buyValue) && buyValue >= 0 && buyValue <= 100000 && validQtyFor(qtyValue, live.unit, true);
  const changedElsewhere = live.qty !== product.qty || live.sellPrice !== product.sellPrice || live.buyPrice !== product.buyPrice;
  const save = async () => {
    if (!valid || busy || changedElsewhere) return;
    setBusy(true); setError("");
    try { await quickSetProduct(shopId, live.id, sellValue, buyValue, qtyValue); onSaved(tq("saved")); onClose(); }
    catch { setError(tq("failed")); }
    finally { setBusy(false); }
  };
  return <Sheet open onClose={() => { if (!busy) onClose(); }} title={names(live, locale).primary} footer={<button type="button" className="btn btn-primary w-full text-lg" disabled={!valid || busy || changedElsewhere} onClick={save}>{busy ? t("common.saving") : t("common.save")}</button>}>
    <div className="space-y-4 pb-2">
      <p className="text-ink-soft">{tq("intro")}</p>
      <label className="block"><span className="label">{tq("sell", { unit: t(`unit.${live.unit}`) })}</span><input className="input" inputMode="decimal" value={sell} onChange={(e) => setSell(e.target.value)} /></label>
      <label className="block"><span className="label">{tq("buy")}</span><input className="input" inputMode="decimal" value={buy} onChange={(e) => setBuy(e.target.value)} /><span className="text-sm text-ink-soft">{tq("buyHint")}</span></label>
      <div className="rounded-2xl bg-card p-3"><p className="font-semibold">{tq("current", { qty: formatNum(live.qty), unit: t(`unit.${live.unit}`) })}</p><label className="mt-2 block"><span className="label">{tq("counted", { unit: t(`unit.${live.unit}`) })}</span><input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></label><p className="mt-1 text-sm text-ink-soft">{tq("countHint")}</p></div>
      {changedElsewhere && <p role="alert" className="font-semibold text-brick">{tq("changed")}</p>}
      {!valid && <p role="alert" className="font-semibold text-brick">{tq("invalid")}</p>}
      {error && <p role="alert" className="font-semibold text-brick">{error}</p>}
      <button type="button" className="btn btn-ghost w-full" onClick={() => { onClose(); onDetails(live); }}>{tq("details")}</button>
    </div>
  </Sheet>;
}
