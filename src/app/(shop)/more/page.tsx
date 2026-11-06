"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { OfflineReadiness, useShop } from "@/components/AppShell";
import { AppLockPanel } from "@/components/AppLockPanel";
import { BackupExport, BackupRestore } from "@/components/BackupPanel";
import { CloudPanel } from "@/components/CloudPanel";
import { IconChevron, IconDownload } from "@/components/Icons";
import { LangToggle } from "@/components/LangToggle";
import { RecoveryHelp } from "@/components/RecoveryHelp";
import { Toast } from "@/components/Toast";
import { logout } from "@/lib/auth";
import { salesCSVRows } from "@/lib/bills";
import { CASH_DAYS_CSV_HEADERS, cashDayCSVRow, loadAllCashDays } from "@/lib/cash";
import { downloadCSV, toCSV } from "@/lib/csv";
import { dayKey, fmtDate } from "@/lib/dates";
import { db, type Locale, type Shop } from "@/lib/db";
import { useCanInstall, useNow, useSessionUser } from "@/lib/hooks";
import { promptInstall } from "@/lib/install";
import { updateShop } from "@/lib/ops";
import { seedDemo } from "@/lib/seed";
import { refundsOf, SALES_CSV_HEADERS } from "@/lib/payments";
import { STOCK_MOVES_CSV_HEADERS, stockMovesCSVRows } from "@/lib/stockHistory";
import { csvItem, PRODUCTS_CSV_HEADERS, productsCSVRows } from "@/lib/units";

export default function MorePage() {
  const shop = useShop();
  const t = useTranslations();
  const tm = useTranslations("more");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const now = useNow();
  const installable = useCanInstall();
  const userId = useSessionUser();
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  const exportData = async (kind: "products" | "sales" | "customers" | "ledger" | "corrections" | "moves" | "cash") => {
    const stamp = dayKey(now);
    if (kind === "cash") {
      const days = await loadAllCashDays(shop.id);
      downloadCSV(`galla-${stamp}.csv`, toCSV(CASH_DAYS_CSV_HEADERS, days.map(cashDayCSVRow)));
    } else if (kind === "moves") {
      const moves = await db.stockMoves.where("shopId").equals(shop.id).toArray();
      const products = await db.products.where("shopId").equals(shop.id).toArray();
      downloadCSV(`stock-history-${stamp}.csv`, toCSV(STOCK_MOVES_CSV_HEADERS, stockMovesCSVRows(moves, products)));
    } else if (kind === "products") {
      const rows = await db.products.where("shopId").equals(shop.id).toArray();
      downloadCSV(
        `stock-${stamp}.csv`,
        toCSV(
          PRODUCTS_CSV_HEADERS,
          productsCSVRows(rows),
        ),
      );
    } else if (kind === "sales") {
      const rows = await db.sales.where("shopId").equals(shop.id).toArray();
      const custs = new Map((await db.customers.where("shopId").equals(shop.id).toArray()).map((c) => [c.id, c.name]));
      downloadCSV(`sales-${stamp}.csv`, toCSV(SALES_CSV_HEADERS, salesCSVRows(rows, (id) => (id ? custs.get(id) : undefined))));
    } else if (kind === "corrections") {
      const rows = (await db.corrections.where("shopId").equals(shop.id).toArray()).sort((a, b) => a.createdAt - b.createdAt);
      const custs = new Map((await db.customers.where("shopId").equals(shop.id).toArray()).map((c) => [c.id, c.name]));
      downloadCSV(
        `corrections-${stamp}.csv`,
        toCSV(
          ["date", "bill_id", "type", "items", "amount", "cost", "refund_method", "refund_split", "cross_method", "customer", "reason", "by"],
          rows.map((c) => [
            fmtDate(c.createdAt, "en", "yyyy-MM-dd HH:mm"),
            c.saleId,
            c.type,
            c.lines.map(csvItem).join("; "),
            c.amount,
            c.cost,
            c.refundMethod,
            refundsOf(c)
              .map((r) => `${r.method}:${r.amount}`)
              .join("; "),
            c.crossMethod ? "yes" : "",
            c.customerId ? custs.get(c.customerId) : "",
            c.reason,
            c.byName,
          ]),
        ),
      );
    } else if (kind === "customers") {
      const rows = await db.customers.where("shopId").equals(shop.id).toArray();
      downloadCSV(`customers-${stamp}.csv`, toCSV(["name", "phone", "balance"], rows.map((c) => [c.name, c.phone, c.balance])));
    } else {
      const rows = (await db.ledger.where("shopId").equals(shop.id).toArray()).sort((a, b) => a.createdAt - b.createdAt);
      const custs = new Map((await db.customers.where("shopId").equals(shop.id).toArray()).map((c) => [c.id, c.name]));
      downloadCSV(
        `udhaar-${stamp}.csv`,
        toCSV(
          ["date", "customer", "type", "amount", "method", "note"],
          rows.map((e) => [fmtDate(e.createdAt, "en", "yyyy-MM-dd HH:mm"), custs.get(e.customerId), e.type === "debit" ? "gave_credit" : e.kind === "return" ? "return_udhaar_reduced" : "payment_received", e.amount, e.type === "credit" && !e.kind ? (e.method ?? "cash") : "", e.note]),
        ),
      );
    }
  };

  const reset = async () => {
    if (!window.confirm(tm("resetConfirm"))) return;
    await seedDemo(shop.ownerId);
    setToast(t("common.saved"));
  };

  return (
    <div className="space-y-8">
      <h1 className="font-brand text-4xl font-semibold">{tm("title")}</h1>

      <div className="grid grid-cols-2 gap-3">
        {(["stock", "alerts", "sales"] as const).map((key) => (
          <Link key={key} href={`/${key}`} className="card flex min-h-[64px] items-center justify-between gap-2 p-4 font-bold">
            <span className="min-w-0 break-words">{t(`nav.${key}`)}</span><IconChevron />
          </Link>
        ))}
      </div>

      {!shop.isDemo && <Link href="/firstweek" className="card flex min-h-[64px] items-center justify-between gap-3 p-4 font-bold"><span>{t("firstWeek.title")}</span><IconChevron /></Link>}

      <Link href="/pricing" className="card flex min-h-[64px] items-center justify-between gap-3 p-4 font-bold"><span>{t("pricing.title")}</span><IconChevron /></Link>

      <Link href="/hisaab" className="card flex min-h-[64px] items-center gap-3 p-4" data-testid="more-report">
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-bold">{tm("reportTitle")}</span>
          <span className="block text-ink-soft">{tm("reportSub")}</span>
        </span>
        <IconChevron />
      </Link>

      <Link href="/orders" className="card flex min-h-[64px] items-center gap-3 p-4" data-testid="more-orders">
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-bold">{tm("ordersTitle")}</span>
          <span className="block text-ink-soft">{tm("ordersSub")}</span>
        </span>
        <IconChevron />
      </Link>

      <Link href="/suppliers" className="card flex min-h-[64px] items-center gap-3 p-4" data-testid="more-suppliers">
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-bold">{tm("suppliersTitle")}</span>
          <span className="block text-ink-soft">{tm("suppliersSub")}</span>
        </span>
        <IconChevron />
      </Link>

      <section>
        <h2 className="eyebrow mb-2">{t("common.language")}</h2>
        <LangToggle shopId={shop.id} />
      </section>

      <ShopForm key={shop.updatedAt} shop={shop} onSaved={() => setToast(t("common.saved"))} />

      <CloudPanel shop={shop} onToast={setToast} />

      <section id="backup" className="scroll-mt-4 space-y-3">
        <h2 className="eyebrow">{t("backup.title")}</h2>
        <p className="text-ink-soft">{t("backup.hint")}</p>
        <div className="card p-5">
          <BackupExport shopId={shop.id} onToast={setToast} />
        </div>
        <div className="card space-y-2 p-5">
          <h3 className="text-lg font-bold">{t("backup.restore")}</h3>
          <BackupRestore ownerId={shop.ownerId} currentShop={shop} onRestored={() => setToast(t("backup.restored"))} />
        </div>
      </section>

      <RecoveryHelp shop={shop} />

      {userId && <AppLockPanel userId={userId} onToast={setToast} />}

      <section>
        <h2 className="eyebrow mb-2">{tm("data")}</h2>
        <p className="mb-3 text-ink-soft">{tm("exportHint")}</p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
          {(
            [
              ["products", tm("exportProducts")],
              ["sales", tm("exportSales")],
              ["customers", tm("exportCustomers")],
              ["ledger", tm("exportLedger")],
              ["corrections", tm("exportCorrections")],
              ["moves", tm("exportMoves")],
              ["cash", tm("exportCash")],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className="btn btn-ghost justify-start" onClick={() => exportData(k)}>
              <IconDownload /> {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="eyebrow mb-2">{tm("offline")}</h2>
        <OfflineReadiness className="text-lg font-semibold" />
        <p className="mt-1 text-ink-soft">{tm("offlineHint")}</p>
      </section>

      <section>
        <h2 className="eyebrow mb-2">{tm("install")}</h2>
        {installable ? (
          <button type="button" className="btn btn-teal" onClick={() => void promptInstall()}>
            {tm("install")}
          </button>
        ) : (
          <p className="text-ink-soft">{tm("installHint")}</p>
        )}
      </section>

      <section className="space-y-2 border-t-2 border-ink/80 pt-5">
        <h2 className="eyebrow">{tm("account")}</h2>
        {shop.isDemo && (
          <button type="button" className="btn btn-ghost w-full" onClick={reset}>
            {tm("resetDemo")}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost w-full text-brick"
          onClick={() => {
            logout();
            router.replace("/login");
          }}
        >
          {tm("logout")}
        </button>
        <p className="pt-2 text-center text-sm text-ink-soft">Vyaplio v0.1 · {locale === "hi" ? "हिंदी" : "English"}</p>
      </section>
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

function ShopForm({ shop, onSaved }: { shop: Shop; onSaved: () => void }) {
  const t = useTranslations();
  const tm = useTranslations("more");
  const [f, setF] = useState({
    name: shop.name,
    ownerName: shop.ownerName,
    phone: shop.phone ?? "",
    upiId: shop.upiId ?? "",
    deadStockDays: String(shop.deadStockDays),
    expiryWarnDays: String(shop.expiryWarnDays),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateShop(shop.id, {
      name: f.name.trim() || shop.name,
      ownerName: f.ownerName.trim(),
      phone: f.phone.replace(/\D/g, "") || undefined,
      upiId: f.upiId.trim() || undefined,
      deadStockDays: Math.max(1, Number(f.deadStockDays) || 30),
      expiryWarnDays: Math.max(0, Number(f.expiryWarnDays) || 7),
    });
    onSaved();
  };
  const input = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label" htmlFor={`sf-${k}`}>
        {label}
      </label>
      <input id={`sf-${k}`} className="input" value={f[k]} onChange={set(k)} {...props} />
    </div>
  );
  return (
    <form onSubmit={save} className="card space-y-4 p-5">
      <h2 className="text-xl font-bold">{tm("shop")}</h2>
      {input("name", t("setup.shopName"))}
      {input("ownerName", t("setup.ownerName"))}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
        {input("phone", t("setup.phone"), { inputMode: "tel" })}
        {input("upiId", t("setup.upiId"))}
      </div>
      <h3 className="pt-2 text-lg font-bold">{tm("alertSettings")}</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
        {input("deadStockDays", tm("deadDays"), { type: "number", inputMode: "numeric", min: 1 })}
        {input("expiryWarnDays", tm("expiryDays"), { type: "number", inputMode: "numeric", min: 0 })}
      </div>
      <button type="submit" className="btn btn-teal w-full">
        {t("common.save")}
      </button>
    </form>
  );
}
