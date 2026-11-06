"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { builtinAliases, parseAliases } from "@/lib/aliases";
import { db, type Locale, type Product, type Unit } from "@/lib/db";
import { formatNum } from "@/lib/money";
import { names } from "@/lib/names";
import { DEVANAGARI_RE } from "@/lib/translit";
import { deleteProduct, ProductError, saveProduct, type ProductInput } from "@/lib/ops";
import { DEFAULT_STEP, fmtQty, kindOf, LOOSE_PRESETS, PRODUCT_KINDS, unitsFor, type ProductKind } from "@/lib/units";
import { BarcodeScanner } from "./BarcodeScanner";
import { IconScan } from "./Icons";
import { Sheet } from "./Sheet";

type Draft = Record<"nameHi" | "nameEn" | "sellPrice" | "buyPrice" | "qty" | "lowStockAt" | "expiryDate" | "barcode" | "supplier" | "aliases" | "reorderTo" | "mrp" | "looseId" | "packSize", string> & {
  unit: Unit;
  kind: ProductKind;
  step: number;
};

const toDraft = (p?: Product, name = ""): Draft => ({
  // A new item started from search / voice ("add चीनी") gets that text as its name.
  nameHi: p?.nameHi ?? (DEVANAGARI_RE.test(name) ? name : ""),
  nameEn: p?.nameEn ?? (DEVANAGARI_RE.test(name) ? "" : name),
  unit: p?.unit ?? "pcs",
  kind: p ? kindOf(p) : "packed",
  step: p?.step ?? DEFAULT_STEP,
  mrp: p?.mrp ? String(p.mrp) : "",
  looseId: p?.looseId ?? "",
  packSize: p?.packSize ? String(p.packSize) : "",
  sellPrice: p ? String(p.sellPrice) : "",
  // 0 = not entered: show an empty field (never a "free" item).
  buyPrice: p && p.buyPrice > 0 ? String(p.buyPrice) : "",
  qty: p ? String(p.qty) : "",
  lowStockAt: p ? String(p.lowStockAt) : "5",
  expiryDate: p?.expiryDate ?? "",
  barcode: p?.barcode ?? "",
  supplier: p?.supplier ?? "",
  reorderTo: p?.reorderTo ? String(p.reorderTo) : "",
  aliases: p?.aliases?.join(", ") ?? "",
});

export function ProductForm({ shopId, product, initialName, onClose, onAdjust }: { shopId: string; product?: Product; initialName?: string; onClose: () => void; onAdjust?: (p: Product) => void }) {
  const t = useTranslations();
  const ts = useTranslations("stock");
  const locale = useLocale() as Locale;
  const [d, setD] = useState<Draft>(() => toDraft(product, initialName?.trim()));
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const suppliers = useLiveQuery(() => db.suppliers.where("shopId").equals(shopId).toArray(), [shopId]);
  // Loose products a sealed pack can be opened into (1 kg atta packet → loose atta).
  const looseProducts = useLiveQuery(
    async () => (await db.products.where("shopId").equals(shopId).toArray()).filter((x) => kindOf(x) === "loose" && x.id !== product?.id),
    [shopId, product?.id],
  );
  const loose = d.kind === "loose";
  const linked = looseProducts?.find((x) => x.id === d.looseId);
  const setKind = (kind: ProductKind) => setD((prev) => ({ ...prev, kind, unit: unitsFor(kind).includes(prev.unit) ? prev.unit : unitsFor(kind)[0] }));
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });
  const n = (s: string) => (s.trim() === "" ? 0 : Number(s));
  const builtin = useMemo(() => builtinAliases(d.nameHi, d.nameEn), [d.nameHi, d.nameEn]);

  const save = async () => {
    const sell = n(d.sellPrice);
    if ((!d.nameHi.trim() && !d.nameEn.trim()) || !(sell > 0)) {
      setError(ts("required"));
      return;
    }
    const input: ProductInput = {
      nameHi: d.nameHi.trim() || d.nameEn.trim(),
      nameEn: d.nameEn.trim() || d.nameHi.trim(),
      unit: d.unit,
      sellPrice: sell,
      buyPrice: n(d.buyPrice),
      // Opening stock for a new item; ignored when editing (stock changes only through moves).
      qty: product ? product.qty : Math.max(0, n(d.qty)),
      lowStockAt: Math.max(0, n(d.lowStockAt)),
      expiryDate: d.expiryDate || undefined,
      barcode: d.barcode.trim() || undefined,
      supplier: d.supplier.trim() || undefined,
      // Empty = suggested orders fill up to twice the low-stock level.
      reorderTo: n(d.reorderTo) > 0 ? n(d.reorderTo) : undefined,
      // Always passed (saveProduct merges over the old row), so clearing the field clears them.
      aliases: parseAliases(d.aliases),
      kind: d.kind,
      // Loose: + / − step; packed: MRP and the loose product it opens into (cleared for the other kind).
      step: loose ? d.step : undefined,
      mrp: !loose && n(d.mrp) > 0 ? n(d.mrp) : undefined,
      looseId: !loose && d.looseId ? d.looseId : undefined,
      packSize: !loose && d.looseId ? n(d.packSize) : undefined,
    };
    try {
      await saveProduct(shopId, input, product?.id);
      onClose();
    } catch (e) {
      if (!(e instanceof ProductError)) throw e;
      setError(ts(`err_${e.code}`));
    }
  };

  const remove = async () => {
    if (product && window.confirm(t("common.confirmDelete"))) {
      await deleteProduct(product.id);
      onClose();
    }
  };

  const field = (k: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label" htmlFor={`pf-${k}`}>
        {label}
      </label>
      <input id={`pf-${k}`} className="input" value={d[k]} onChange={set(k)} {...props} />
    </div>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={product ? ts("editTitle") : ts("addTitle")}
      footer={
        <div className="flex gap-2">
          {product && (
            <button type="button" className="btn btn-ghost text-brick" onClick={remove}>
              {t("common.delete")}
            </button>
          )}
          <button type="button" className="btn btn-primary flex-1 text-lg" onClick={save}>
            {t("common.save")}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {field("nameHi", ts("nameHi"), { placeholder: "चीनी", lang: "hi" })}
        {field("nameEn", ts("nameEn"), { placeholder: "Sugar", lang: "en" })}
        <div>
          <label className="label" htmlFor="pf-aliases">
            {ts("aliases")}
          </label>
          <input id="pf-aliases" className="input" value={d.aliases} onChange={set("aliases")} placeholder={ts("aliasesPlaceholder")} autoComplete="off" />
          <p className="mt-1 text-sm text-ink-soft">{builtin.length ? ts("aliasesBuiltin", { list: builtin.slice(0, 8).join(", ") }) : ts("aliasesHint")}</p>
        </div>
        <fieldset>
          <legend className="label">{ts("kind")}</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {PRODUCT_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={d.kind === k}
                onClick={() => setKind(k)}
                data-testid={`pf-kind-${k}`}
                className={`min-h-14 rounded-2xl border-2 px-2 text-left ${d.kind === k ? "border-teal bg-teal/10" : "border-line bg-card"}`}
              >
                <span className="block font-bold">{ts(k === "loose" ? "kindLoose" : "kindPacked")}</span>
                <span className="block text-sm text-ink-soft">{ts(k === "loose" ? "kindLooseHint" : "kindPackedHint")}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
          {field("sellPrice", loose ? ts("sellPricePer", { unit: t(`unit.${d.unit}`) }) : ts("sellPrice"), { inputMode: "decimal", type: "number", step: "0.01", min: "0" })}
          {field("buyPrice", ts("buyPrice"), { inputMode: "decimal", type: "number", step: "0.01", min: "0" })}
        </div>
        {!(n(d.buyPrice) > 0) ? (
          <p className="text-sm text-ink-soft" data-testid="buy-hint">{ts("buyPriceHint")}</p>
        ) : n(d.sellPrice) > 0 && n(d.buyPrice) > n(d.sellPrice) ? (
          <p className="text-sm font-semibold text-brick" role="note">{ts("buyAboveSell")}</p>
        ) : null}
        {product && (
          <div className="rounded-2xl bg-paper-2/70 p-4">
            <p className={`num text-lg font-bold ${product.qty < 0 ? "text-brick" : ""}`}>{ts("current", { qty: `${formatNum(product.qty)} ${t(`unit.${product.unit}`)}` })}</p>
            <p className="mt-1 text-sm text-ink-soft">{ts("qtyEditHint")}</p>
            {onAdjust && (
              <button type="button" className="btn btn-ghost mt-2 w-full" onClick={() => onAdjust(product)}>
                {ts("adjust")}
              </button>
            )}
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
          {!product && field("qty", ts("qty"), { inputMode: loose ? "decimal" : "numeric", type: "number", step: loose ? "0.01" : "1", min: "0" })}
          <div>
            <label className="label" htmlFor="pf-unit">
              {ts("unit")}
            </label>
            <select id="pf-unit" className="input" value={d.unit} onChange={set("unit")}>
              {unitsFor(d.kind).map((u) => (
                <option key={u} value={u}>
                  {t(`unit.${u}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {loose ? (
          <div>
            <label className="label" htmlFor="pf-step">
              {ts("step")}
            </label>
            <select id="pf-step" className="input" value={String(d.step)} onChange={(e) => setD({ ...d, step: Number(e.target.value) })} data-testid="pf-step">
              {LOOSE_PRESETS.map((q) => (
                <option key={q} value={String(q)}>
                  {fmtQty(t, q, d.unit)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-ink-soft">{ts("stepHint")}</p>
          </div>
        ) : (
          <div className="space-y-3 rounded-2xl bg-paper-2/70 p-4">
            {field("mrp", ts("mrp"), { inputMode: "decimal", type: "number", step: "0.01", min: "0" })}
            <div>
              <label className="label" htmlFor="pf-loose">
                {ts("packOf")}
              </label>
              <select id="pf-loose" className="input" value={d.looseId} onChange={set("looseId")} data-testid="pf-loose">
                <option value="">{ts("packOfNone")}</option>
                {(looseProducts ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {names(x, locale).primary} ({t(`unit.${x.unit}`)})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-ink-soft">{ts("packOfHint")}</p>
            </div>
            {d.looseId && field("packSize", ts("packSize", { unit: t(`unit.${linked?.unit ?? "kg"}`) }), { inputMode: "decimal", type: "number", step: "0.01", min: "0", placeholder: "1" })}
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
          {field("lowStockAt", ts("lowStockAt"), { inputMode: "decimal", type: "number", min: "0" })}
          {field("reorderTo", ts("reorderTo"), { inputMode: "decimal", type: "number", min: "0", placeholder: String(Math.max(1, n(d.lowStockAt) * 2)) })}
          {field("expiryDate", loose ? ts("expiry") : ts("expiryBatch"), { type: "date" })}
        </div>
        <div>
          <label className="label" htmlFor="pf-barcode">
            {ts("barcode")}
          </label>
          <div className="flex gap-2">
            <input id="pf-barcode" className="input num" inputMode="numeric" value={d.barcode} onChange={set("barcode")} />
            <button type="button" className="icon-btn shrink-0 bg-paper-2 text-teal-deep" onClick={() => setScan(true)} aria-label={t("scan.button")}>
              <IconScan />
            </button>
          </div>
        </div>
        {field("supplier", ts("supplier"), { list: "pf-suppliers", autoComplete: "off" })}
        <datalist id="pf-suppliers">
          {(suppliers ?? []).map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
        {error && <p className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">{error}</p>}
      </div>
      <BarcodeScanner
        open={scan}
        onClose={() => setScan(false)}
        onDetected={(code) => {
          setD((prev) => ({ ...prev, barcode: code }));
          setScan(false);
        }}
      />
    </Sheet>
  );
}
