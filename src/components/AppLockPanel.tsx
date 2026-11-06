"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { lockApp, refreshLock } from "@/lib/lock";
import { getPinRecord, LOCK_AFTER_CHOICES, pinSupported, removePin, setLockAfter, verifyPin } from "@/lib/pin";
import { PinPad } from "./PinPad";
import { PinSetup } from "./PinSetup";
import { Sheet } from "./Sheet";

/** More → App lock: set / change / remove the PIN, when to lock again, lock now. */
export function AppLockPanel({ userId, onToast }: { userId: string; onToast: (m: string) => void }) {
  const t = useTranslations("pin");
  const rec = useLiveQuery(async () => (await getPinRecord(userId)) ?? null, [userId]);
  const [sheet, setSheet] = useState<null | "set" | "change" | "remove">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const close = () => {
    setSheet(null);
    setMsg(null);
  };
  const removeWithPin = async (pin: string) => {
    const r = await verifyPin(userId, pin);
    if (!r.ok) {
      setMsg(r.waitMs ? t("wait", { sec: Math.ceil(r.waitMs / 1000) }) : t("wrong", { left: r.attemptsLeft }));
      return;
    }
    await removePin(userId);
    await refreshLock(userId);
    close();
    onToast(t("removed"));
  };
  if (rec === undefined) return null;
  return (
    <section className="card space-y-3 p-5" data-testid="app-lock">
      <h2 className="text-xl font-bold">{t("panelTitle")}</h2>
      <p className={rec ? "text-ink-soft" : "font-semibold text-mustard-ink"}>{rec ? t("panelOn") : t("panelOff")}</p>
      {!pinSupported() && <p className="text-sm text-brick">{t("noCrypto")}</p>}
      {rec ? (
        <>
          <fieldset>
            <legend className="label">{t("lockAfter")}</legend>
            <div className="flex flex-wrap gap-2">
              {LOCK_AFTER_CHOICES.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={rec.lockAfterMin === m}
                  onClick={() => void setLockAfter(userId, m)}
                  className={`min-h-12 min-w-12 rounded-full border-2 px-4 font-bold ${rec.lockAfterMin === m ? "border-teal bg-teal text-paper" : "border-line bg-card text-ink"}`}
                >
                  {m === 0 ? t("min0") : t("minN", { n: m })}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
            <button type="button" className="btn btn-teal" onClick={() => lockApp(userId)} data-testid="lock-now">
              {t("lockNow")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSheet("change")}>
              {t("change")}
            </button>
            <button type="button" className="btn btn-ghost text-brick" onClick={() => setSheet("remove")}>
              {t("remove")}
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn btn-teal w-full" disabled={!pinSupported()} onClick={() => setSheet("set")} data-testid="pin-set-open">
          {t("set")}
        </button>
      )}
      <Sheet open={sheet !== null} onClose={close} title={sheet === "remove" ? t("remove") : sheet === "change" ? t("change") : t("set")}>
        {sheet === "remove" ? (
          <PinPad id="pinremove" label={t("enterCurrent")} onComplete={removeWithPin} message={msg} tone="error" />
        ) : sheet ? (
          <PinSetup
            userId={userId}
            requireCurrent={sheet === "change"}
            onDone={() => {
              close();
              onToast(t("saved"));
            }}
          />
        ) : null}
      </Sheet>
    </section>
  );
}
