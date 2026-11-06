"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Customer, Locale, Sale, SaleCorrection, Shop } from "@/lib/db";
import { receiptHtml, type ReceiptFormat } from "@/lib/receipt";

/** Inline preview avoids a second modal or a pop-up, including when opened from an old bill. */
export function ReceiptPrint({ sale, shop, customer, corrections = [] }: {
  sale: Sale; shop: Shop; customer?: Pick<Customer, "name">; corrections?: SaleCorrection[];
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ReceiptFormat>("a4");
  const [loadedHtml, setLoadedHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const html = open ? receiptHtml(t, { sale, shop, customer, corrections, locale, format }) : "";
  const print = () => {
    setFailed(false);
    try {
      const target = frame.current?.contentWindow;
      if (!target || loadedHtml !== html || typeof target.print !== "function") throw new Error("Print unavailable");
      target.focus();
      target.print();
    } catch {
      setFailed(true);
    }
  };
  return <div className="mt-3 text-left">
    <button type="button" className="btn btn-ghost w-full" aria-expanded={open} onClick={() => {
      setOpen(!open); setLoadedHtml(null); setFailed(false);
    }}>{t(open ? "receipt.hide" : "receipt.open")}</button>
    {open && <div className="mt-3 space-y-3 rounded-2xl border border-line bg-card p-3">
      <label className="label block">{t("receipt.paper")}
        <select className="input mt-1" value={format} onChange={(e) => { setFormat(e.target.value as ReceiptFormat); setLoadedHtml(null); setFailed(false); }}>
          <option value="a4">A4</option><option value="80mm">{t("receipt.thermal", { size: 80 })}</option><option value="58mm">{t("receipt.thermal", { size: 58 })}</option>
        </select>
      </label>
      <p className="text-sm text-ink-soft">{t("receipt.printHint")}</p>
      <iframe key={html} ref={frame} title={t("receipt.preview")} srcDoc={html} sandbox="allow-same-origin allow-modals"
        className="h-64 w-full rounded-lg border border-line bg-white" onLoad={() => setLoadedHtml(html)} />
      <button type="button" className="btn btn-teal w-full" disabled={loadedHtml !== html} onClick={print}>{t("receipt.print")}</button>
      {failed && <p role="alert" className="font-semibold text-brick">{t("receipt.failed")}</p>}
    </div>}
  </div>;
}
