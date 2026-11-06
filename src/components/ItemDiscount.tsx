"use client";

import { useTranslations } from "next-intl";
import type { SaleDraft } from "@/lib/db";
import { formatINR } from "@/lib/money";

type Input = NonNullable<SaleDraft["itemDiscounts"]>[string];

/** Item rupee discounts apply to the whole selected quantity; percentages follow quantity changes. */
export function ItemDiscount({ name, value, amount, net, invalid, onChange }: {
  name: string; value?: Input; amount: number; net: number; invalid: boolean; onChange: (value: Input | null) => void;
}) {
  const t = useTranslations("discount");
  return <fieldset className="min-w-0 rounded-xl border border-line p-3">
    <legend className="sr-only">{t("itemFor", { name })}</legend>
    {!value ? <button type="button" className="min-h-12 text-left font-bold text-teal" onClick={() => onChange({ kind: "amount", value: "" })}>{t("itemAdd")}</button> : <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold">{t("itemTitle")}</span>
        <button type="button" className="min-h-12 px-2 font-bold text-brick" onClick={() => onChange(null)}>{t("remove")}</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="label min-w-0">{t("type")}
          <select className="input mt-1" value={value.kind} onChange={(e) => onChange({ kind: e.target.value as Input["kind"], value: "" })}>
            <option value="amount">{t("rupees")}</option><option value="percent">{t("percent")}</option>
          </select>
        </label>
        <label className="label min-w-0">{t(value.kind === "amount" ? "amountValue" : "percentValue")}
          <input className="input num mt-1" inputMode="decimal" placeholder="0" value={value.value} aria-invalid={invalid} onChange={(e) => onChange({ ...value, value: e.target.value })} />
        </label>
      </div>
      <p className="mt-2 text-sm text-ink-soft">{t("itemHint")}</p>
      {invalid ? <p role="alert" className="mt-2 font-semibold text-brick">{t("itemInvalid")}</p> : amount > 0 && <p className="num mt-2 font-semibold">{t("itemResult", { discount: formatINR(amount), net: formatINR(net) })}</p>}
    </>}
  </fieldset>;
}
