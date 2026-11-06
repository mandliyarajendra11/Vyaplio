"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { useShop } from "@/components/AppShell";
import { IconChevron, IconDownload, IconWhatsApp } from "@/components/Icons";
import { Sheet } from "@/components/Sheet";
import { Toast } from "@/components/Toast";
import {
  addCashEntry,
  CASH_DAYS_CSV_HEADERS,
  CASH_ENTRIES_CSV_HEADERS,
  CashError,
  cashDayCSVRow,
  cashDayText,
  cashEntryCSVRows,
  closeDay,
  COINS,
  denomTotal,
  isCashOut,
  loadAllCashDays,
  setOpening,
  voidCashEntry,
  type CashDay,
} from "@/lib/cash";
import { useActor } from "@/lib/actor";
import { downloadCSV, toCSV } from "@/lib/csv";
import { DAY_MS, dayKey, fmtDate, fmtTime } from "@/lib/dates";
import { CASH_MANUAL_KINDS, db, DENOMS, EXPENSE_CATEGORIES, type CashEntry, type CashManualKind, type ExpenseCategory, type Locale, type Supplier } from "@/lib/db";
import { normName } from "@/lib/supplierMigrate";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useCashDay, useClosings, useNow } from "@/lib/hooks";
import { formatINR, round2 } from "@/lib/money";
import { waLink } from "@/lib/whatsapp";

const shiftDay = (day: string, by: number) => dayKey(new Date(`${day}T12:00:00`).getTime() + by * DAY_MS);

export default function GallaPage() {
  const shop = useShop();
  const t = useTranslations();
  const tc = useTranslations("cash");
  const locale = useLocale() as Locale;
  const now = useNow();
  const today = now ? dayKey(now) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? today;
  const data = useCashDay(shop.id, day);
  const closings = useClosings(shop.id);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const [adding, setAdding] = useState<CashManualKind | null>(null);
  const [voiding, setVoiding] = useState<CashEntry | null>(null);
  const [editOpening, setEditOpening] = useState(false);
  const [correcting, setCorrecting] = useState<{ day: string; reason: string } | null>(null);
  const [askCorrect, setAskCorrect] = useState(false);
  const actor = useActor(shop);
  const suppliers = useLiveQuery(() => db.suppliers.where("shopId").equals(shop.id).toArray(), [shop.id]);

  if (!day || !data) return <p role="status">{t("common.loading")}</p>;
  const byName = actor.name;
  const correction = correcting?.day === day ? correcting.reason : null;
  const locked = data.closed && !correction;

  const errText = (e: unknown) => {
    const code = e instanceof CashError ? e.code : null;
    return code === "reason" ? tc("errReason") : code === "category" ? tc("errCategory") : code === "future" ? tc("errFuture") : code === "amount" ? tc("errAmount") : t("common.saveFailed");
  };

  const exportDays = async () => {
    const days = await loadAllCashDays(shop.id);
    downloadCSV(`galla-${dayKey(Date.now())}.csv`, toCSV(CASH_DAYS_CSV_HEADERS, days.map(cashDayCSVRow)));
  };
  const exportEntries = async () => {
    const rows = await db.cashEntries.where("shopId").equals(shop.id).toArray();
    downloadCSV(`galla-entries-${dayKey(Date.now())}.csv`, toCSV(CASH_ENTRIES_CSV_HEADERS, cashEntryCSVRows(rows)));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-brand text-4xl font-semibold">{tc("title")}</h1>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="icon-btn bg-paper-2" aria-label={tc("prevDay")} onClick={() => setPicked(shiftDay(day, -1))}>
            <IconChevron className="rotate-180" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-lg font-bold" data-testid="galla-day">{fmtDate(day, locale, "EEEE, d MMM yyyy")}</p>
            <span className={`rounded-full px-3 py-0.5 text-sm font-extrabold ${data.closed ? "bg-leaf text-paper" : "bg-mustard-soft text-ink"}`} data-testid="galla-status">
              {data.closed ? tc("statusClosed") : tc("statusOpen")}
            </span>
            {day !== today && (
              <button type="button" className="ml-2 min-h-12 text-sm font-bold text-teal underline" onClick={() => setPicked(null)}>
                {tc("today")}
              </button>
            )}
          </div>
          <button type="button" className="icon-btn bg-paper-2 disabled:opacity-50" aria-label={tc("nextDay")} disabled={!today || day >= today} onClick={() => setPicked(shiftDay(day, 1))}>
            <IconChevron />
          </button>
        </div>
      </div>

      {data.late.count > 0 && (
        <p role="alert" className="rounded-2xl border-2 border-brick bg-brick/10 px-4 py-3 font-semibold text-brick" data-testid="galla-late">
          {tc("lateWarn", { count: data.late.count, expected: formatINR(data.expected), atClose: formatINR(data.close?.expected ?? data.closes[0]?.expected ?? 0) })}
        </p>
      )}
      {correction && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-mustard-soft px-4 py-2 font-semibold">
          <span>{tc("correcting", { reason: correction })}</span>
          <button type="button" className="min-h-12 font-bold text-teal underline" onClick={() => setCorrecting(null)}>
            {tc("stopCorrect")}
          </button>
        </div>
      )}

      {/* Opening */}
      <section className="card p-4" aria-labelledby="g-open">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="g-open" className="text-lg font-bold">{tc("opening")}</h2>
          <p className="num font-brand text-3xl font-bold" data-testid="galla-opening">{formatINR(data.opening)}</p>
        </div>
        <p className="text-sm text-ink-soft">
          {data.openingSource === "entry"
            ? tc("openingEdited", { reason: data.openingEntry?.reason ?? "—" })
            : data.carried
              ? tc("openingCarried", { date: fmtDate(data.carried.day, locale, "d MMM") })
              : tc("openingNone")}
        </p>
        {!locked && !editOpening && (
          <button type="button" className="mt-1 min-h-12 min-w-12 px-2 font-bold text-teal" onClick={() => setEditOpening(true)}>
            {tc("editOpening")}
          </button>
        )}
        {editOpening && !locked && (
          <OpeningForm
            initial={data.opening}
            carried={data.carried?.amount ?? 0}
            correction={correction}
            onCancel={() => setEditOpening(false)}
            onSave={async (amount, reason) => {
              try {
                await setOpening({ shopId: shop.id, day, amount, reason: reason || correction || undefined, byName });
                setEditOpening(false);
                setToast(tc("saved"));
              } catch (e) {
                setToast(errText(e));
              }
            }}
          />
        )}
      </section>

      <Breakdown data={data} />

      {/* Manual entries */}
      <section aria-labelledby="g-entries">
        <h2 id="g-entries" className="eyebrow">{tc("entries")}</h2>
        {!locked && (
          <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
            {CASH_MANUAL_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`min-h-[52px] rounded-2xl border-2 px-2 font-extrabold ${isCashOut(k) ? "border-brick/40 text-brick" : "border-leaf/50 text-leaf"}`}
                onClick={() => setAdding(k)}
              >
                {isCashOut(k) ? "−" : "+"} {tc(`kind_${k}`)}
              </button>
            ))}
          </div>
        )}
        <ul className="ruled mt-2">
          {data.manual.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="cash-entry">
              <div className="min-w-0">
                <p className="font-bold">
                  {tc(`kind_${e.kind}`)}
                  {e.category && ` · ${tc(`cat_${e.category}`)}`}
                  {e.supplierName && ` · ${e.supplierName}`}
                  {data.late.ids.has(e.id) && <span className="ml-2 rounded-full bg-brick px-2 text-xs text-paper">{tc("lateBadge")}</span>}
                </p>
                <p className="line-clamp-2 text-sm text-ink-soft">
                  <span className="num">{fmtTime(e.createdAt, locale)}</span>
                  {e.note && <> · {e.note}</>}
                  {e.reason && <> · {e.reason}</>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`num text-lg font-bold ${isCashOut(e.kind) ? "text-brick" : "text-leaf"}`}>
                  {isCashOut(e.kind) ? "−" : "+"}
                  {formatINR(e.amount)}
                </span>
                {!locked && (
                  <button type="button" className="min-h-12 px-2 text-sm font-semibold text-ink-soft underline" onClick={() => setVoiding(e)}>
                    {tc("voidBtn")}
                  </button>
                )}
              </div>
            </li>
          ))}
          {data.voided.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-ink-soft line-through">
              <span>
                {tc(`kind_${e.kind}`)} {e.category && `· ${tc(`cat_${e.category}`)}`}
              </span>
              <span className="num">{formatINR(e.amount)}</span>
            </li>
          ))}
          {data.manual.length === 0 && data.voided.length === 0 && <li className="py-4 text-ink-soft">{tc("noEntries")}</li>}
        </ul>
      </section>

      {/* Count + close */}
      {data.closed && !correction ? (
        <ClosedCard
          data={data}
          onCorrect={() => setAskCorrect(true)}
        />
      ) : (
        <CountForm
          key={`${day}-${data.closes.length}`}
          expected={data.expected}
          needsReason={data.closed}
          onClose={async (counted, denoms, reason) => {
            try {
              await closeDay({ shopId: shop.id, day, counted, denoms, reason: reason || correction || undefined, byName });
              setCorrecting(null);
              setToast(tc("closedToast"));
            } catch (e) {
              setToast(errText(e));
            }
          }}
        />
      )}
      {correction && data.close && (
        <button
          type="button"
          className="btn btn-ghost w-full border-brick/40 text-brick"
          onClick={async () => {
            try {
              await voidCashEntry({ entryId: data.close!.id, reason: correction, byName });
              setCorrecting(null);
              setToast(tc("saved"));
            } catch (e) {
              setToast(errText(e));
            }
          }}
        >
          {tc("reopen")}
        </button>
      )}

      <div className="flex flex-wrap gap-2">
        <a href={waLink(cashDayText(t, data, shop, locale))} target="_blank" rel="noreferrer" className="btn btn-wa" data-testid="galla-wa">
          <IconWhatsApp /> {tc("share")}
        </a>
        <button type="button" className="btn btn-ghost" onClick={exportDays}>
          <IconDownload /> {tc("csv")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={exportEntries}>
          <IconDownload /> {tc("csvEntries")}
        </button>
      </div>

      <section aria-labelledby="g-past">
        <h2 id="g-past" className="eyebrow">{tc("past")}</h2>
        <ul className="ruled mt-1" data-testid="galla-past">
          {(closings ?? []).map((c) => (
            <li key={c.day}>
              <button type="button" className="flex min-h-[56px] w-full items-center justify-between gap-3 py-2 text-left" onClick={() => setPicked(c.day)}>
                <span className="min-w-0">
                  <span className="block font-bold">{fmtDate(c.day, locale, "EEE, d MMM")}</span>
                  <span className="num block text-sm text-ink-soft">{tc("pastLine", { expected: formatINR(c.expected), counted: formatINR(c.close?.amount ?? 0) })}</span>
                </span>
                <DiffBadge diff={c.diff ?? 0} />
              </button>
            </li>
          ))}
          {closings && closings.length === 0 && <li className="py-4 text-ink-soft">{tc("noPast")}</li>}
        </ul>
      </section>

      {adding && (
        <EntrySheet
          kind={adding}
          correction={correction}
          onClose={() => setAdding(null)}
          suppliers={suppliers}
          onSave={async (v) => {
            try {
              // A typed name that matches a supplier record is linked to it (supplier diary).
              const match = v.supplierName ? suppliers?.find((s) => normName(s.name) === normName(v.supplierName!)) : undefined;
              await addCashEntry({ shopId: shop.id, day, kind: adding, ...v, supplierId: match?.id, supplierName: match?.name ?? v.supplierName, reason: correction ?? undefined, byName });
              setAdding(null);
              setToast(tc("saved"));
            } catch (e) {
              setToast(errText(e));
            }
          }}
        />
      )}
      {voiding && (
        <ReasonSheet
          title={`${tc("voidBtn")}: ${tc(`kind_${voiding.kind}`)} ${formatINR(voiding.amount)}`}
          label={tc("voidReason")}
          initial={correction ?? ""}
          onClose={() => setVoiding(null)}
          onSave={async (reason) => {
            try {
              await voidCashEntry({ entryId: voiding.id, reason, byName });
              setVoiding(null);
              setToast(tc("saved"));
            } catch (e) {
              setToast(errText(e));
            }
          }}
        />
      )}
      {askCorrect && (
        <ReasonSheet
          title={tc("correctTitle")}
          hint={tc("correctHint")}
          label={tc("correctReason")}
          submit={tc("correctStart")}
          initial=""
          onClose={() => setAskCorrect(false)}
          onSave={(reason) => {
            setCorrecting({ day, reason });
            setAskCorrect(false);
          }}
        />
      )}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

function DiffBadge({ diff }: { diff: number }) {
  const tc = useTranslations("cash");
  const match = Math.abs(diff) < 0.005;
  return (
    <span
      data-testid="diff-badge"
      className={`num shrink-0 rounded-full px-3 py-1 text-sm font-extrabold ${match ? "bg-leaf/15 text-leaf" : diff < 0 ? "bg-brick text-paper" : "bg-mustard text-ink"}`}
    >
      {match ? tc("diffMatch") : diff < 0 ? tc("diffShort", { amount: formatINR(-diff) }) : tc("diffOver", { amount: formatINR(diff) })}
    </span>
  );
}

function Row({ label, value, sign, testId }: { label: string; value: number; sign: "+" | "−"; testId?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 py-1">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`num font-bold ${value ? (sign === "+" ? "text-leaf" : "text-brick") : "text-ink-soft"}`} data-testid={testId}>
        {sign}
        {formatINR(value)}
      </dd>
    </div>
  );
}

function Breakdown({ data }: { data: CashDay }) {
  const tc = useTranslations("cash");
  return (
    <>
      <section className="card p-4" aria-label={tc("expected")}>
        <h2 className="eyebrow">{tc("cashIn")}</h2>
        <dl>
          <Row label={tc("inSales")} value={data.cashIn.sales} sign="+" testId="in-sales" />
          {data.tendered > 0 && <p className="num -mt-1 text-xs text-ink-soft">{tc("tenderedInfo", { tendered: formatINR(data.tendered), change: formatINR(data.change) })}</p>}
          <Row label={tc("inUdhaar")} value={data.cashIn.udhaar} sign="+" testId="in-udhaar" />
          <Row label={tc("inAdded")} value={data.cashIn.added} sign="+" />
        </dl>
        <h2 className="eyebrow mt-3">{tc("cashOut")}</h2>
        <dl>
          <Row label={tc("outRefunds")} value={data.cashOut.refunds} sign="−" testId="out-refunds" />
          <Row label={tc("outExpense")} value={data.cashOut.expense} sign="−" testId="out-expense" />
          <Row label={tc("outSupplier")} value={data.cashOut.supplier} sign="−" />
          <Row label={tc("outWithdrawal")} value={data.cashOut.withdrawal} sign="−" />
          <Row label={tc("outBank")} value={data.cashOut.bank} sign="−" />
        </dl>
        <div className="mt-3 flex flex-wrap items-baseline justify-between border-t-2 border-ink/80 pt-3">
          <span className="text-lg font-bold">{tc("expected")}</span>
          <span className="num font-brand text-[clamp(1.75rem,9vw,2.25rem)] [overflow-wrap:anywhere] font-bold" data-testid="galla-expected">{formatINR(data.expected)}</span>
        </div>
      </section>
      <section className="rounded-2xl bg-teal/10 px-4 py-3" aria-label={tc("upiTitle")}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-bold text-teal-deep">{tc("upiTitle")}</h2>
          <span className="num text-xl font-bold text-teal-deep" data-testid="galla-upi">{formatINR(data.upi.net)}</span>
        </div>
        <p className="num text-sm text-ink-soft">{tc("upiLine", { sales: formatINR(data.upi.sales), udhaar: formatINR(data.upi.udhaar), refunds: formatINR(data.upi.refunds) })}</p>
        {data.upi.pending > 0 && <p className="text-sm font-semibold text-mustard-ink">{tc("upiPending", { amount: formatINR(data.upi.pending) })}</p>}
      </section>
    </>
  );
}

function OpeningForm(props: { initial: number; carried: number; correction: string | null; onCancel: () => void; onSave: (amount: number, reason: string) => void }) {
  const tc = useTranslations("cash");
  const t = useTranslations("common");
  const [amount, setAmount] = useState(String(props.initial));
  const [reason, setReason] = useState("");
  const v = Number(amount);
  const needReason = Math.abs(v - props.carried) > 0.005 && !props.correction;
  return (
    <div className="mt-2 space-y-2">
      <input className="input num text-2xl" inputMode="decimal" aria-label={tc("opening")} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
      {needReason && <input className="input" aria-label={tc("openingReason")} placeholder={tc("openingReason")} value={reason} onChange={(e) => setReason(e.target.value)} />}
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
          ←
        </button>
        <button type="button" className="btn btn-teal flex-1" disabled={!Number.isFinite(v) || v < 0 || !amount || (needReason && !reason.trim())} onClick={() => props.onSave(v, reason)}>
          {t("save")}
        </button>
      </div>
    </div>
  );
}

function CountForm({ expected, needsReason, onClose }: { expected: number; needsReason: boolean; onClose: (counted: number | undefined, denoms: Record<string, number> | undefined, reason: string) => Promise<void> }) {
  const tc = useTranslations("cash");
  const [mode, setMode] = useState<"notes" | "total">("notes");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [total, setTotal] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const denoms = Object.fromEntries(Object.entries(notes).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)]));
  const counted = mode === "notes" ? denomTotal(denoms) : total === "" ? NaN : round2(Number(total));
  const valid = Number.isFinite(counted) && counted >= 0 && (mode === "total" || Object.keys(denoms).length > 0);
  const diff = valid ? round2(counted - expected) : 0;
  return (
    <section className="card space-y-3 p-4" aria-labelledby="g-count" data-testid="count-form">
      <h2 id="g-count" className="text-xl font-bold">{tc("countTitle")}</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2" role="radiogroup" aria-label={tc("countTitle")}>
        {(["notes", "total"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`min-h-[48px] rounded-2xl border-2 font-extrabold ${mode === m ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}>
            {m === "notes" ? tc("countByNotes") : tc("countTotal")}
          </button>
        ))}
      </div>
      {mode === "notes" ? (
        <div className="space-y-1.5">
          {[...DENOMS.map(String), COINS].map((k) => (
            <label key={k} className="flex items-center gap-3">
              <span className="num w-24 font-bold">{k === COINS ? tc("coins") : `₹${k} ×`}</span>
              <input
                className="input num flex-1 text-xl"
                inputMode={k === COINS ? "decimal" : "numeric"}
                aria-label={k === COINS ? tc("coins") : tc("note_count", { denom: k })}
                value={notes[k] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [k]: e.target.value.replace(k === COINS ? /[^\d.]/g : /\D/g, "") }))}
              />
              <span className="num w-20 text-right text-ink-soft">{notes[k] ? formatINR(k === COINS ? Number(notes[k]) : Number(k) * Number(notes[k])) : ""}</span>
            </label>
          ))}
        </div>
      ) : (
        <input className="input num text-2xl" inputMode="decimal" aria-label={tc("counted")} placeholder={tc("counted")} value={total} onChange={(e) => setTotal(e.target.value.replace(/[^\d.]/g, ""))} />
      )}
      {valid && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-paper-2 px-4 py-3">
          <span>
            <span className="block text-sm text-ink-soft">{tc("counted")}</span>
            <span className="num font-brand text-3xl font-bold" data-testid="counted-total">{formatINR(counted)}</span>
          </span>
          <DiffBadge diff={diff} />
        </div>
      )}
      {(needsReason || (valid && Math.abs(diff) >= 0.005)) && (
        <input className="input" aria-label={tc("diffReason")} placeholder={needsReason ? tc("correctReason") : tc("diffReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
      )}
      <button
        type="button"
        className="btn btn-primary min-h-[60px] w-full text-xl"
        disabled={!valid || busy}
        onClick={async () => {
          setBusy(true);
          await onClose(mode === "total" ? counted : undefined, mode === "notes" ? denoms : undefined, reason);
          setBusy(false);
        }}
      >
        {needsReason ? tc("recount") : tc("closeBtn")}
      </button>
    </section>
  );
}

function ClosedCard({ data, onCorrect }: { data: CashDay; onCorrect: () => void }) {
  const tc = useTranslations("cash");
  const locale = useLocale() as Locale;
  const c = data.close!;
  return (
    <section className="card space-y-2 border-leaf p-4" data-testid="closed-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="num font-brand text-3xl font-bold">{tc("closedCounted", { amount: formatINR(c.amount) })}</p>
          <p className="text-sm text-ink-soft">{tc("closedAt", { time: fmtTime(c.createdAt, locale), name: c.byName ?? "—" })}</p>
        </div>
        <DiffBadge diff={data.diff ?? 0} />
      </div>
      {c.reason && <p>“{c.reason}”</p>}
      {data.closes.length > 1 && (
        <ul className="text-sm text-ink-soft">
          {data.closes.slice(0, -1).map((x) => (
            <li key={x.id} className="num line-through">
              {fmtTime(x.createdAt, locale)} · {formatINR(x.amount)}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-ghost w-full" onClick={onCorrect}>
        {tc("correctBtn")}
      </button>
    </section>
  );
}

function EntrySheet(props: {
  kind: CashManualKind;
  correction: string | null;
  onClose: () => void;
  onSave: (v: { amount: number; category?: ExpenseCategory; note?: string; supplierName?: string }) => Promise<void>;
  suppliers?: Supplier[];
}) {
  const tc = useTranslations("cash");
  const t = useTranslations("common");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [note, setNote] = useState("");
  const [supplier, setSupplier] = useState("");
  const [busy, setBusy] = useState(false);
  const v = Number(amount);
  const ok = Number.isFinite(v) && v > 0 && (props.kind !== "expense" || !!category);
  return (
    <Sheet
      open
      onClose={() => !busy && props.onClose()}
      title={tc(`kind_${props.kind}`)}
      footer={
        <button
          type="button"
          className="btn btn-primary w-full min-h-[56px] text-lg"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            await props.onSave({ amount: v, category: category ?? undefined, note, supplierName: supplier });
            setBusy(false);
          }}
        >
          {t("save")}
        </button>
      }
    >
      <div className="space-y-3">
        {props.correction && <p className="rounded-xl bg-mustard-soft px-3 py-2 text-sm font-semibold">{tc("correcting", { reason: props.correction })}</p>}
        <input className="input num text-2xl" inputMode="decimal" aria-label={tc("amount")} placeholder={tc("amount")} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} autoFocus />
        {props.kind === "expense" && (
          <div>
            <p className="label">{tc("category")}</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tc("category")}>
              {EXPENSE_CATEGORIES.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} onClick={() => setCategory(c)} className={`min-h-12 rounded-full border-2 px-3 font-semibold ${category === c ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}>
                  {tc(`cat_${c}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {props.kind === "supplier" && (
          <>
            <input className="input" aria-label={tc("supplierName")} placeholder={tc("supplierName")} value={supplier} onChange={(e) => setSupplier(e.target.value)} list="galla-suppliers" autoComplete="off" />
            <datalist id="galla-suppliers">
              {(props.suppliers ?? []).map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
            <p className="text-sm text-ink-soft">
              {tc("supplierDiaryHint")}{" "}
              <Link href="/suppliers" className="font-semibold text-teal underline">
                {tc("supplierDiaryLink")}
              </Link>
            </p>
          </>
        )}
        <input className="input" aria-label={tc("note")} placeholder={tc("note")} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Sheet>
  );
}

function ReasonSheet(props: { title: string; label: string; hint?: string; submit?: string; initial: string; onClose: () => void; onSave: (reason: string) => void | Promise<void> }) {
  const t = useTranslations("common");
  const [reason, setReason] = useState(props.initial);
  return (
    <Sheet
      open
      onClose={props.onClose}
      title={props.title}
      footer={
        <button type="button" className="btn btn-primary w-full min-h-[56px]" disabled={!reason.trim()} onClick={() => props.onSave(reason.trim())}>
          {props.submit ?? t("save")}
        </button>
      }
    >
      {props.hint && <p className="mb-3 text-ink-soft">{props.hint}</p>}
      <input className="input" aria-label={props.label} placeholder={props.label} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
    </Sheet>
  );
}
