"use client";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useMemo, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconChevron, IconPlus, IconWhatsApp } from "@/components/Icons";
import { matches, SearchBar } from "@/components/SearchBar";
import { Sheet } from "@/components/Sheet";
import { fmtDate } from "@/lib/dates";
import { db, type Customer, type LedgerEntry, type Locale, type Shop } from "@/lib/db";
import { useCustomers } from "@/lib/hooks";
import { formatINR } from "@/lib/money";
import { addCustomer, addLedger } from "@/lib/ops";
import { reminderText } from "@/lib/share";
import { waLink } from "@/lib/whatsapp";
import { useSaveAction } from "@/lib/useSaveAction";

export default function UdhaarPage() {
  // useSearchParams needs a Suspense boundary so the page can still be prerendered (and cached offline).
  return (
    <Suspense fallback={<Loading />}>
      <UdhaarInner />
    </Suspense>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p role="status">{t("loading")}</p>;
}

function UdhaarInner() {
  const shop = useShop();
  const tu = useTranslations("udhaar");
  const locale = useLocale() as Locale;
  const customers = useCustomers(shop.id);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Deep link from a bill: /udhaar?customer=<id> opens that customer (until closed).
  const linked = useSearchParams().get("customer");
  const [linkClosed, setLinkClosed] = useState<string | null>(null);
  const shownId = openId ?? (linked && linkClosed !== linked ? linked : null);
  const closeSheet = () => {
    setOpenId(null);
    setLinkClosed(linked);
    if (linked) window.history.replaceState(window.history.state, "", "/udhaar");
  };

  const list = useMemo(
    () => (customers ?? []).filter((c) => matches(query, c.name, c.phone)).sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name)),
    [customers, query],
  );
  const totalDue = (customers ?? []).reduce((a, c) => a + Math.max(c.balance, 0), 0);
  const open = customers?.find((c) => c.id === shownId);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-4xl font-semibold">{tu("title")}</h1>
        <Link href="/orders" className="min-h-12 content-center font-semibold text-teal" data-testid="udhaar-orders">
          📦 {tu("ordersLink")} →
        </Link>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          <IconPlus /> {tu("add")}
        </button>
      </div>
      <div className="mt-4 border-y-2 border-ink/80 py-3">
        <p className="eyebrow">{tu("totalDue")}</p>
        <p className="num font-brand text-[clamp(2rem,11vw,3rem)] [overflow-wrap:anywhere] font-bold text-brick">{formatINR(totalDue)}</p>
        <p className="text-ink-soft">{tu("customers", { count: customers?.length ?? 0 })}</p>
      </div>
      <div className="mt-4">
        <SearchBar value={query} onChange={setQuery} placeholder={tu("search")} />
      </div>

      <ul className="ruled mt-3">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => setOpenId(c.id)} className="flex min-h-[76px] w-full flex-wrap items-center gap-3 py-3 text-left">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-paper-2 font-deva text-xl font-bold text-teal-deep">
                {c.name.slice(0, 1)}
              </span>
              <span className="min-w-[min(100%,9rem)] flex-1">
                <span className="block text-xl font-bold break-words">{c.name}</span>
                <span className="line-clamp-2 block text-sm text-ink-soft">
                  {c.lastPaidAt ? tu("lastPaid", { date: fmtDate(c.lastPaidAt, locale) }) : tu("neverPaid")}
                </span>
              </span>
              <span className="text-right">
                <span className={`num block text-xl font-extrabold ${c.balance > 0 ? "text-brick" : "text-leaf"}`}>{formatINR(Math.abs(c.balance))}</span>
                <span className="text-xs font-semibold text-ink-soft">{c.balance > 0 ? tu("due") : c.balance < 0 ? tu("advance") : tu("clear")}</span>
              </span>
              <IconChevron className="shrink-0 text-ink-soft" />
            </button>
          </li>
        ))}
        {customers && list.length === 0 && <li className="py-10 text-center text-lg text-ink-soft">{tu("none")}</li>}
      </ul>

      {adding && <AddCustomer shopId={shop.id} onClose={(id) => { setAdding(false); if (id) setOpenId(id); }} />}
      {open && <CustomerSheet key={open.id} shop={shop} customer={open} onClose={closeSheet} />}
    </div>
  );
}

function AddCustomer({ shopId, onClose }: { shopId: string; onClose: (id?: string) => void }) {
  const tu = useTranslations("udhaar");
  const tc = useTranslations("common");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const { busy, failed, run } = useSaveAction();
  const save = async () => {
    if (!name.trim()) return;
    await run(async () => {
      const c = await addCustomer(shopId, name, phone, { address, landmark });
      onClose(c.id);
    });
  };
  return (
    <Sheet
      open
      onClose={() => { if (!busy) onClose(); }}
      title={tu("add")}
      footer={
        <button type="button" className="btn btn-primary w-full text-lg" onClick={save} disabled={busy || !name.trim()}>
          {busy ? tc("saving") : tc("save")}
        </button>
      }
    >
      {failed && <p role="alert" className="mb-3 font-semibold text-brick">{tc("saveFailed")}</p>}
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div>
          <label className="label" htmlFor="cn">{tu("name")}</label>
          <input id="cn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="cp">{tu("phone")}</label>
          <input id="cp" className="input num" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ca">{tu("address")}</label>
          <input id="ca" className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cl">{tu("landmark")}</label>
          <input id="cl" className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} placeholder={tu("landmarkPh")} />
        </div>
      </fieldset>
    </Sheet>
  );
}

function CustomerSheet({ shop, customer, onClose }: { shop: Shop; customer: Customer; onClose: () => void }) {
  const t = useTranslations();
  const tu = useTranslations("udhaar");
  const locale = useLocale() as Locale;
  const [mode, setMode] = useState<LedgerEntry["type"] | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [via, setVia] = useState<"cash" | "upi">("cash");
  const { busy, failed, run } = useSaveAction();
  const billCount = useLiveQuery(() => db.sales.where("customerId").equals(customer.id).count(), [customer.id]);
  const entries = useLiveQuery(
    async () => (await db.ledger.where("customerId").equals(customer.id).toArray()).sort((a, b) => b.createdAt - a.createdAt),
    [customer.id],
  );

  const save = async () => {
    const v = Number(amount);
    if (!mode || !Number.isFinite(v) || !(v > 0)) return;
    await run(async () => {
      await addLedger(shop.id, customer.id, mode, v, note, mode === "credit" ? via : undefined);
      setMode(null);
      setAmount("");
      setNote("");
      setVia("cash");
    });
  };

  return (
    <Sheet open onClose={() => { if (!busy) onClose(); }} title={customer.name}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">{customer.balance >= 0 ? tu("due") : tu("advance")}</p>
          <p className={`num font-brand text-[clamp(2rem,11vw,3rem)] [overflow-wrap:anywhere] font-bold ${customer.balance > 0 ? "text-brick" : "text-leaf"}`}>{formatINR(Math.abs(customer.balance))}</p>
          {customer.phone && <a href={`tel:${customer.phone}`} className="num inline-block min-h-12 content-center text-teal">{customer.phone}</a>}
        </div>
      </div>

      {failed && <p role="alert" className="mt-3 font-semibold text-brick">{t("common.saveFailed")}</p>}
      <fieldset disabled={busy} className="min-w-0">
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
        <button type="button" onClick={() => setMode("debit")} className={`min-h-[60px] rounded-2xl border-2 text-lg font-extrabold ${mode === "debit" ? "border-brick bg-brick text-paper" : "border-brick/40 text-brick"}`}>
          + {tu("gave")}
        </button>
        <button type="button" onClick={() => setMode("credit")} className={`min-h-[60px] rounded-2xl border-2 text-lg font-extrabold ${mode === "credit" ? "border-leaf bg-leaf text-paper" : "border-leaf/40 text-leaf"}`}>
          − {tu("got")}
        </button>
      </div>

      {mode && (
        <div className="card mt-3 space-y-3 p-4">
          <input className="input num text-2xl" inputMode="decimal" type="number" min="0" placeholder={tu("amount")} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus aria-label={tu("amount")} />
          {mode === "credit" && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2" role="radiogroup" aria-label={tu("got")}>
              {(["cash", "upi"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={via === m} onClick={() => setVia(m)} className={`min-h-[48px] rounded-2xl border-2 font-extrabold ${via === m ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}>
                  {m === "cash" ? tu("viaCash") : tu("viaUpi")}
                </button>
              ))}
            </div>
          )}
          <input className="input" placeholder={tu("note")} value={note} onChange={(e) => setNote(e.target.value)} aria-label={tu("note")} />
          <button type="button" className="btn btn-teal w-full" onClick={save} disabled={busy || !Number.isFinite(Number(amount)) || !(Number(amount) > 0)}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      )}
      </fieldset>

      <Link href={`/customer?id=${encodeURIComponent(customer.id)}`} className="btn btn-teal mt-3 w-full" data-testid="customer-open">
        🧺 {tu("openCustomer")}
      </Link>
      <Link href={`/sales?range=all&customer=${customer.id}`} className="btn btn-ghost mt-3 w-full" data-testid="customer-bills">
        {t("bills.customerBills")}
        {billCount !== undefined && <span className="num"> ({billCount})</span>}
      </Link>

      {customer.balance > 0 && (
        <a href={waLink(reminderText(t, customer, shop), customer.phone)} target="_blank" rel="noreferrer" className="btn btn-wa mt-3 w-full min-h-[56px]">
          <IconWhatsApp /> {tu("remind")}
        </a>
      )}

      <h3 className="eyebrow mt-6">{tu("ledger")}</h3>
      <ul className="ruled mt-1">
        {(entries ?? []).map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="font-semibold">{e.kind === "return" ? tu("entryReturn") : e.saleId ? tu("entrySale") : e.type === "debit" ? tu("entryDebit") : e.method === "upi" ? tu("entryCreditUpi") : tu("entryCredit")}</p>
              <p className="line-clamp-2 text-sm text-ink-soft">
                <span className="num">{fmtDate(e.createdAt, locale, "d MMM, h:mm a")}</span>
                {e.note && <> · {e.note}</>}
              </p>
            </div>
            <span className={`num text-lg font-bold ${e.type === "debit" ? "text-brick" : "text-leaf"}`}>
              {e.type === "debit" ? "+" : "−"}
              {formatINR(e.amount)}
            </span>
          </li>
        ))}
        {entries && entries.length === 0 && <li className="py-6 text-ink-soft">{tu("noEntries")}</li>}
      </ul>
    </Sheet>
  );
}
