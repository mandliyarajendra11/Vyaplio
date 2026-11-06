"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Product, Unit } from "@/lib/db";
import { downloadCSV, toCSV } from "@/lib/csv";
import { IMPORT_BYTES, IMPORT_HEADERS, type ImportRow, readImport, validateImport } from "@/lib/productImport";
import { importProducts, type ProductInput } from "@/lib/ops";
import { parseDecimal } from "@/lib/productImport";
import { Sheet } from "./Sheet";

const UNITS: Unit[] = ["pcs", "pkt", "box", "kg", "ltr"];

export function ProductImportSheet({ shopId, products, onClose, onSaved }: { shopId: string; products: Product[]; onClose: () => void; onSaved: (message: string) => void }) {
  const t = useTranslations();
  const ti = useTranslations("import");
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => validateImport(rows, products, (key) => ti(key)), [rows, products, ti]);
  const byLine = useMemo(() => new Map<number, string[]>(rows.map((r) => [r.line, issues.filter((x) => x.line === r.line).map((x) => x.message)])), [rows, issues]);
  const change = (line: number, key: keyof ImportRow, value: string) => setRows((old) => old.map((r) => r.line === line ? { ...r, [key]: value } : r));
  const addBlank = () => {
    setError("");
    setRows((old) => [...old, { line: Math.max(1, ...old.map((r) => r.line)) + 1, name: "", unit: "pcs", sell: "", buy: "", qty: "", barcode: "" }]);
  };
  const choose = async (file?: File) => {
    if (!file) return;
    setRows([]); setError(""); setFileName(file.name);
    if (!file.name.toLowerCase().endsWith(".csv")) { setError(ti("csvOnly")); return; }
    if (file.size > IMPORT_BYTES) { setError(ti("fileLarge")); return; }
    try { setRows(readImport(await file.text())); }
    catch (e) { setError(ti(e instanceof Error && ["csvFormat", "csvEmpty", "csvHeaders", "csvExtra", "csvTooMany"].includes(e.message) ? e.message : "csvFormat")); }
  };
  const save = async () => {
    if (!rows.length || issues.length || busy) return;
    setBusy(true); setError("");
    try {
      const inputs: ProductInput[] = rows.map((r) => ({
        nameHi: r.name, nameEn: r.name, unit: r.unit,
        sellPrice: parseDecimal(r.sell), buyPrice: r.buy ? parseDecimal(r.buy) : 0,
        qty: r.qty ? parseDecimal(r.qty) : 0, lowStockAt: 5,
        barcode: r.barcode || undefined,
      }));
      await importProducts(shopId, inputs);
      onSaved(ti("saved", { count: rows.length }));
      onClose();
    } catch { setError(ti("saveFailed")); }
    finally { setBusy(false); }
  };
  return <Sheet open onClose={() => { if (!busy) onClose(); }} title={ti("title")} footer={rows.length > 0 ? <button type="button" className="btn btn-primary w-full text-lg" disabled={busy || issues.length > 0} onClick={save}>{busy ? t("common.saving") : ti("importCount", { count: rows.length })}</button> : undefined}>
    <div className="space-y-4 pb-2">
      <p className="text-ink-soft">{ti("intro")}</p>
      <button type="button" className="btn btn-primary w-full" onClick={addBlank} disabled={rows.length >= 500}>{rows.length ? ti("addAnother") : ti("typeOne")}</button>
      <p className="text-center text-sm text-ink-soft">{ti("orFile")}</p>
      <div className="rounded-2xl bg-card p-4 space-y-3">
        <p className="font-bold">{ti("step1")}</p>
        <button type="button" className="btn btn-ghost w-full" onClick={() => downloadCSV("vyaplio-products-template.csv", toCSV(IMPORT_HEADERS, [["चीनी", "kg", 45, 35, 10, ""], ["साबुन", "pcs", 30, 22, 12, ""]]))}>{ti("template")}</button>
        <p className="text-sm text-ink-soft">{ti("templateHint")}</p>
      </div>
      <div className="rounded-2xl bg-card p-4 space-y-3">
        <p className="font-bold">{ti("step2")}</p>
        <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="btn btn-ghost w-full" onClick={() => input.current?.click()}>{ti("choose")}</button>
        {fileName && <p className="break-all text-sm">{fileName}</p>}
      </div>
      {rows.length > 0 && <section className="space-y-3">
        <h3 className="text-xl font-bold">{ti("step3")}</h3>
        <p role="status" className={`rounded-xl p-3 font-semibold ${issues.length ? "bg-brick/10 text-brick" : "bg-leaf/10 text-leaf"}`}>{issues.length ? ti("fixCount", { count: issues.length }) : ti("readyCount", { count: rows.length })}</p>
        <p className="text-sm text-ink-soft">{ti("reviewHint")}</p>
        {rows.map((r, index) => <div key={r.line} className="card space-y-3 p-3">
          <div className="flex items-center justify-between gap-2"><p className="font-bold">{ti("row", { line: index + 1 })}</p><button type="button" className="min-h-12 font-semibold text-brick underline" onClick={() => setRows((old) => old.filter((x) => x.line !== r.line))}>{ti("remove")}</button></div>
          {(byLine.get(r.line) ?? []).map((message, i) => <p role="alert" key={i} className="font-semibold text-brick">{message}</p>)}
          <label className="block"><span className="label">{ti("name")}</span><input className="input" value={r.name} onChange={(e) => change(r.line, "name", e.target.value)} /></label>
          <label className="block"><span className="label">{ti("unit")}</span><select className="input" value={UNITS.includes(r.unit) ? r.unit : ""} onChange={(e) => change(r.line, "unit", e.target.value)}><option value="">{ti("selectUnit")}</option>{UNITS.map((u) => <option key={u} value={u}>{t(`unit.${u}`)}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-2">
            <label><span className="label">{ti("sell")}</span><input className="input" inputMode="decimal" value={r.sell} onChange={(e) => change(r.line, "sell", e.target.value)} /></label>
            <label><span className="label">{ti("buy")}</span><input className="input" inputMode="decimal" value={r.buy} onChange={(e) => change(r.line, "buy", e.target.value)} /></label>
          </div>
          <label className="block"><span className="label">{ti("qty")}</span><input className="input" inputMode="decimal" value={r.qty} onChange={(e) => change(r.line, "qty", e.target.value)} /><span className="text-sm text-ink-soft">{ti("qtyHint")}</span></label>
          <label className="block"><span className="label">{ti("barcode")}</span><input className="input" inputMode="numeric" value={r.barcode} onChange={(e) => change(r.line, "barcode", e.target.value)} /></label>
        </div>)}
      </section>}
      {error && <p role="alert" className="rounded-xl bg-brick/10 p-3 font-semibold text-brick">{error}</p>}
    </div>
  </Sheet>;
}
