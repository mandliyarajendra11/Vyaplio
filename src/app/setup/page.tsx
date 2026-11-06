"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackupRestore } from "@/components/BackupPanel";
import { CloudRecover } from "@/components/CloudPanel";
import { LangToggle } from "@/components/LangToggle";
import { PinSetup } from "@/components/PinSetup";
import { RecoveryPoints } from "@/components/RecoveryHelp";
import { Wordmark } from "@/components/Wordmark";
import type { Locale } from "@/lib/db";
import { useSessionUser, useShopForUser } from "@/lib/hooks";
import { unlockApp } from "@/lib/lock";
import { back, isLast, next, progress, saveDraft, skip, type OnboardData, type OnboardState, type StepError } from "@/lib/onboarding";
import { setLocale } from "@/lib/prefs";
import { finishOnboarding } from "@/lib/setupShop";
import { SHOP_TYPES, starterFor, type PickedItem } from "@/lib/starter";
import { isSupabaseConfigured } from "@/lib/supabase/client";

type Mode = "welcome" | "steps" | "backup" | "newPhone";

/**
 * Assisted first-run setup: welcome (plans / backup file / new phone), then one
 * question per screen with a progress bar. Every answer is saved on this phone, so closing the
 * app midway resumes at the same question. Existing shops never see this screen.
 */
export default function SetupPage() {
  const t = useTranslations("onboard");
  const tb = useTranslations("backup");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const userId = useSessionUser();
  const shop = useShopForUser(userId);
  // Keep previous drafts stored, but opening a new shop now requires activation.
  const [st, setSt] = useState<OnboardState | null>(null);
  const [mode, setMode] = useState<Mode>("welcome");
  const [err, setErr] = useState<StepError | "failed" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) router.replace("/login");
    else if (shop) router.replace("/");
  }, [userId, shop, router]);

  // Every change is kept on the phone right away (resume after closing the app).
  useEffect(() => {
    if (userId && st) void saveDraft(userId, st);
  }, [userId, st]);

  if (!userId || shop) return <div className="min-h-dvh" />;

  const patch = (p: Partial<OnboardData>) => st && setSt({ ...st, data: { ...st.data, ...p } });
  const goNext = (p: Partial<OnboardData> = {}) => {
    if (!st) return;
    const r = next(st, p);
    setErr(r.error);
    setSt(r.state);
    window.scrollTo({ top: 0 });
  };
  const finish = async () => {
    if (!st) return;
    setBusy(true);
    setErr(null);
    try {
      await finishOnboarding(st, userId, t("defaultShopName"));
      unlockApp(userId); // the PIN was just chosen: do not ask for it straight away
      router.replace("/");
    } catch {
      setErr("failed");
      setBusy(false);
    }
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Wordmark size="sm" sub={false} />
      <LangToggle />
    </div>
  );

  if (mode !== "steps" || !st) {
    return (
      <div className="page-enter mx-auto min-h-dvh max-w-[560px] px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-10" data-testid="onboard-welcome">
        {header}
        {mode === "welcome" && (
          <>
            <h1 className="mt-8 font-brand text-[clamp(2rem,9vw,2.5rem)] leading-tight font-semibold">{t("welcomeTitle")}</h1>
            <p className="mt-2 text-lg text-ink-soft">{t("welcomeSub")}</p>
            <div className="mt-6 space-y-3">
              <Link href="/pricing" className="btn btn-primary min-h-[72px] w-full rounded-[1.4rem] text-xl">{t("seePlans")} →</Link>
              <p className="text-center text-ink-soft">{t("purchaseFirst")}</p>
              <button type="button" className="btn btn-ghost min-h-[60px] w-full text-lg" onClick={() => setMode("backup")} data-testid="onboard-backup">
                {t("fromBackup")}
              </button>
              <button type="button" className="btn btn-ghost min-h-[60px] w-full text-lg" onClick={() => setMode("newPhone")} data-testid="onboard-newphone">
                {t("newPhone")}
              </button>
            </div>
          </>
        )}
        {mode === "backup" && (
          <section className="card mt-8 space-y-2 p-5">
            <h1 className="text-2xl font-bold">{tb("restore")}</h1>
            <BackupRestore ownerId={userId} onRestored={() => router.replace("/")} />
          </section>
        )}
        {mode === "newPhone" && (
          <section className="mt-8 space-y-3">
            <h1 className="text-2xl font-bold">{t("newPhone")}</h1>
            {isSupabaseConfigured() ? (
              <CloudRecover />
            ) : (
              <>
                <p className="card p-5 text-lg" data-testid="onboard-nocloud">
                  {t("newPhoneNoCloud")}
                </p>
                <button type="button" className="btn btn-teal w-full" onClick={() => setMode("backup")}>
                  {t("fromBackup")}
                </button>
              </>
            )}
          </section>
        )}
        {mode !== "welcome" && (
          <button type="button" className="mt-6 min-h-12 w-full font-semibold text-teal" onClick={() => setMode("welcome")}>
            ← {t("back")}
          </button>
        )}
      </div>
    );
  }

  const step = st.step;
  const { index, total } = progress(st);
  const last = isLast(st);
  const errText = err ? t(`err.${err}`) : null;

  return (
    <div className="page-enter mx-auto flex min-h-dvh max-w-[560px] flex-col px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]" data-testid="onboard" data-step={step}>
      {header}
      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow" data-testid="onboard-progress">
            {t("stepOf", { n: index, total })}
          </p>
        </div>
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index} aria-label={t("stepOf", { n: index, total })}>
          <div className="h-full rounded-full bg-teal transition-[width] duration-300" style={{ width: `${(index / total) * 100}%` }} />
        </div>
      </div>

      <form
        className="mt-6 flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (last) void finish();
          else goNext();
        }}
      >
        <h1 className="font-brand text-[clamp(1.75rem,8vw,2.25rem)] leading-tight font-semibold" id="q">
          {t(`q.${step}`)}
        </h1>
        <p className="mt-2 text-lg text-ink-soft">{t(`h.${step}`)}</p>

        <div className="mt-5 flex-1">
          {step === "language" && (
            <div className="grid gap-3" role="radiogroup" aria-labelledby="q">
              {(["hi", "en"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={st.data.language === l}
                  onClick={() => {
                    setLocale(l);
                    patch({ language: l });
                  }}
                  className={`min-h-[72px] rounded-2xl border-2 px-5 text-left text-2xl font-bold ${st.data.language === l ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
                >
                  {l === "hi" ? "हिंदी" : "English"}
                </button>
              ))}
            </div>
          )}
          {(step === "shopName" || step === "ownerName" || step === "phone" || step === "upi") && (
            <input
              key={step}
              id={`ob-${step}`}
              aria-labelledby="q"
              autoFocus
              className={`input min-h-[64px] text-xl ${step === "phone" ? "num" : ""}`}
              value={st.data[step === "upi" ? "upiId" : step]}
              onChange={(e) => {
                setErr(null);
                patch({ [step === "upi" ? "upiId" : step]: e.target.value });
              }}
              inputMode={step === "phone" ? "tel" : step === "upi" ? "email" : "text"}
              autoComplete={step === "phone" ? "tel" : step === "ownerName" ? "name" : "off"}
              autoCapitalize={step === "upi" ? "none" : "words"}
              enterKeyHint={last ? "done" : "next"}
              placeholder={step === "shopName" ? (locale === "hi" ? "जैसे: गुप्ता किराना स्टोर" : "e.g. Gupta Kirana Store") : step === "phone" ? "98765 43210" : step === "upi" ? "9876543210@ybl" : ""}
              aria-invalid={!!errText}
              aria-describedby={errText ? "ob-err" : undefined}
            />
          )}
          {step === "shopType" && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3" role="radiogroup" aria-labelledby="q">
              {SHOP_TYPES.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={st.data.shopType === k}
                  data-type={k}
                  onClick={() => goNext({ shopType: k, ...(k !== st.data.shopType ? { picked: {} } : {}) })}
                  className={`min-h-[64px] rounded-2xl border-2 px-4 text-left text-lg font-bold ${st.data.shopType === k ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}
                >
                  {t(`type.${k}`)}
                </button>
              ))}
            </div>
          )}
          {step === "products" && <StarterPicker data={st.data} onChange={(picked) => patch({ picked })} />}
          {step === "pin" &&
            (st.data.pinSet ? (
              <p className="rounded-2xl bg-leaf/10 px-4 py-3 text-lg font-bold text-leaf" role="status">
                {t("pinSetDone")}
              </p>
            ) : (
              <>
                <PinSetup userId={userId} id="ob-pin" onDone={() => goNext({ pinSet: true })} />
                <p className="mt-4 text-center text-sm text-ink-soft">{t("pinLater")}</p>
              </>
            ))}
          {step === "safety" && <RecoveryPoints />}
          {errText && (
            <p id="ob-err" role="alert" className="mt-3 rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
              {errText}
            </p>
          )}
        </div>

        <div className="sticky bottom-0 mt-6 space-y-2 bg-paper/95 pt-3 pb-[env(safe-area-inset-bottom)]">
          {(step !== "pin" || st.data.pinSet) && step !== "shopType" && (
            <button type="submit" className="btn btn-primary min-h-[64px] w-full text-xl" disabled={busy} data-testid="onboard-next">
              {last ? (busy ? t("finishing") : t("finish")) : `${t("next")} →`}
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            {index > 1 && (
              <button
                type="button"
                className="btn btn-ghost min-h-12 flex-1"
                onClick={() => {
                  setErr(null);
                  setSt(back(st));
                }}
              >
                ← {t("back")}
              </button>
            )}
            {!last && (
              <button
                type="button"
                className="btn btn-ghost min-h-12 flex-1"
                data-testid="onboard-skip"
                onClick={() => {
                  setErr(null);
                  setSt(skip(st));
                  window.scrollTo({ top: 0 });
                }}
              >
                {t("skip")}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function StarterPicker({ data, onChange }: { data: OnboardData; onChange: (p: Record<string, PickedItem>) => void }) {
  const t = useTranslations("onboard");
  const tu = useTranslations("unit");
  const locale = useLocale() as Locale;
  const items = starterFor(data.shopType);
  const picked = data.picked;
  const count = items.filter(([hi]) => picked[hi]).length;
  if (!items.length) return <p className="card p-5 text-lg">{t("noStarter")}</p>;
  const toggle = (hi: string, on: boolean) => {
    const nextPicked = { ...picked };
    if (on) nextPicked[hi] = picked[hi] ?? {};
    else delete nextPicked[hi];
    onChange(nextPicked);
  };
  const num = (v: string) => {
    const n = Number(v.replace(",", "."));
    return v.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return (
    <div data-testid="starter-list">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold" role="status">
          {t("picked", { count })}
        </p>
        <div className="flex gap-2">
          <button type="button" className="min-h-12 rounded-full border-2 border-line bg-card px-4 font-bold" onClick={() => onChange(Object.fromEntries(items.map(([hi]) => [hi, picked[hi] ?? {}])))}>
            {t("pickAll")}
          </button>
          <button type="button" className="min-h-12 rounded-full border-2 border-line bg-card px-4 font-bold" onClick={() => onChange({})}>
            {t("pickNone")}
          </button>
        </div>
      </div>
      <ul className="space-y-2">
        {items.map(([hi, en, unit]) => {
          const on = !!picked[hi];
          return (
            <li key={hi} className={`rounded-2xl border-2 ${on ? "border-teal bg-card" : "border-line bg-card/60"}`}>
              <label className="flex min-h-[60px] cursor-pointer items-center gap-3 px-4 py-2">
                <input type="checkbox" className="h-7 w-7 shrink-0 accent-teal" checked={on} onChange={(e) => toggle(hi, e.target.checked)} data-item={hi} />
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-bold break-words">{locale === "hi" ? hi : en}</span>
                  <span className="block text-sm text-ink-soft">
                    {locale === "hi" ? en : hi} · {tu(unit)}
                  </span>
                </span>
              </label>
              {on && (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2 px-4 pb-3">
                  <label className="text-sm font-semibold text-ink-soft">
                    {t("price")} / {tu(unit)}
                    <input
                      className="input num mt-1"
                      inputMode="decimal"
                      data-price={hi}
                      defaultValue={picked[hi].price ?? ""}
                      onChange={(e) => onChange({ ...picked, [hi]: { ...picked[hi], price: num(e.target.value) } })}
                    />
                  </label>
                  <label className="text-sm font-semibold text-ink-soft">
                    {t("qty")} ({tu(unit)})
                    <input
                      className="input num mt-1"
                      inputMode="decimal"
                      data-qty={hi}
                      defaultValue={picked[hi].qty ?? ""}
                      onChange={(e) => onChange({ ...picked, [hi]: { ...picked[hi], qty: num(e.target.value) } })}
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
