"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { db, type Locale, type Product } from "@/lib/db";
import { formatNum, round2 } from "@/lib/money";
import { names } from "@/lib/names";
import { openPack } from "@/lib/ops";
import { fmtQty } from "@/lib/units";
import { Sheet } from "./Sheet";
import { Stepper } from "./Stepper";

/**
 * Open sealed packs into loose stock (1 kg atta packet → loose atta): recorded as two "openPack" stock
 * moves. Opening more packs than on record is allowed (item-4 rule) and shown as a shortage.
 */
export function OpenPackSheet({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved?: (msg: string) => void }) {
  const t = useTranslations();
  const to = useTranslations("openPack");
  const locale = useLocale() as Locale;
  const live = useLiveQuery(() => db.products.get(product.id), [product.id]) ?? product;
  const loose = useLiveQuery(() => (live.looseId ? db.products.get(live.looseId) : undefined), [live.looseId]);
  const [packs, setPacks] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = live.packSize ?? 0;
  const add = round2(packs * size);
  const packUnit = t(`unit.${live.unit}`);
  const short = packs > Math.max(0, live.qty);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await openPack({ productId: live.id, packs, note });
      onSaved?.(to("saved", { packs, name: names(live, locale).primary, qty: loose ? fmtQty(t, add, loose.unit) : formatNum(add) }));
      onClose();
    } catch {
      setError(to("failed"));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={to("title", { name: names(live, locale).primary })}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || !loose || !size} onClick={save} data-testid="open-pack-save">
          {busy ? t("common.saving") : to("save", { packs })}
        </button>
      }
    >
      <div className="space-y-4" data-testid="open-pack-sheet">
        {!loose ? (
          <p role="alert" className="font-semibold text-brick">{to("noLink")}</p>
        ) : (
          <>
            <p className="text-ink-soft">{to("intro", { size: fmtQty(t, size, loose.unit), loose: names(loose, locale).primary })}</p>
            <div>
              <p className="label">{to("howMany")}</p>
              <Stepper value={packs} min={1} step={1} size="lg" suffix={packUnit} onChange={(v) => setPacks(Math.max(1, Math.round(v)))} />
            </div>
            <dl className="num space-y-2 rounded-2xl bg-paper-2/70 p-4 text-lg" data-testid="open-pack-preview">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="min-w-0 break-words">{names(live, locale).primary}</dt>
                <dd className="font-bold">
                  {formatNum(live.qty)} → <span className={live.qty - packs < 0 ? "text-brick" : ""}>{formatNum(round2(live.qty - packs))}</span> {packUnit}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="min-w-0 break-words">{names(loose, locale).primary}</dt>
                <dd className="font-bold">
                  {formatNum(loose.qty)} → {formatNum(round2(loose.qty + add))} {t(`unit.${loose.unit}`)}
                </dd>
              </div>
            </dl>
            {short && <p role="status" className="rounded-xl bg-mustard-soft px-4 py-2 font-semibold">{to("short", { have: `${formatNum(live.qty)} ${packUnit}` })}</p>}
            <div>
              <label className="label" htmlFor="op-note">{to("note")}</label>
              <input id="op-note" className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={to("notePh")} />
            </div>
          </>
        )}
        {error && <p role="alert" className="font-semibold text-brick">{error}</p>}
      </div>
    </Sheet>
  );
}
