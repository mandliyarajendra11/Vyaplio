"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Product } from "@/lib/db";
import { parseQuantity } from "@/lib/quantity";
import { fmtQty, isLoose, LOOSE_PRESETS, stepOf } from "@/lib/units";
import { Stepper } from "./Stepper";

/**
 * Quantity on a bill line. Packs: a whole-number stepper. Loose: the product's own step (default 1 kg),
 * 100 g · 250 g · 500 g · 1 kg presets and a button for the weight / ₹ picker.
 */
export function SaleQuantity({ value, product, name, onChange, onPicker }: {
  value: number; product: Product; name: string; onChange: (value: number) => void; onPicker?: () => void;
}) {
  const unit = product.unit;
  const t = useTranslations();
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? null : parseQuantity(draft, unit);
  const loose = isLoose(unit);
  const label = t("sale.editQuantity", { name });
  const select = (quantity: number) => {
    setDraft(null);
    onChange(quantity);
  };
  const apply = () => {
    if (parsed === null) return;
    onChange(parsed);
    setDraft(null);
  };
  return (
    <div className="space-y-2">
      <Stepper value={value} step={stepOf(product)} suffix={t(`unit.${unit}`)} onChange={select}
        onEdit={() => setDraft(String(value))} editLabel={label} />
      {loose && <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {LOOSE_PRESETS.map((q) => <button key={q} type="button"
          aria-pressed={value === q} onClick={() => select(q)}
          className={`min-h-12 rounded-xl border-2 px-3 font-bold ${value === q ? "border-teal bg-teal text-paper" : "border-line bg-paper-2 text-ink"}`}>
          {fmtQty(t, q, unit)}
        </button>)}
        {onPicker && <button type="button" onClick={onPicker} data-testid="sale-picker"
          className="min-h-12 rounded-xl border-2 border-teal px-3 font-bold text-teal">
          {t("sale.pickWeight")}
        </button>}
      </div>}
      {draft !== null && <div className="rounded-xl border border-line p-3">
        <label className="label">
          {t("sale.quantityUnit", { unit: t(`unit.${unit}`) })}
          <input className="input num mt-2" inputMode={loose ? "decimal" : "numeric"} value={draft ?? ""}
            onChange={(event) => setDraft(event.target.value)} autoFocus aria-invalid={parsed === null}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} />
        </label>
        <p className="mt-2 text-ink-soft">{t(loose ? "sale.quantityHelpLoose" : "sale.quantityHelpWhole")}</p>
        {parsed === null && <p role="alert" className="mt-2 text-brick">{t("sale.quantityInvalid")}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={parsed === null} onClick={apply}>{t("common.save")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>{t("common.cancel")}</button>
        </div>
      </div>}
    </div>
  );
}
