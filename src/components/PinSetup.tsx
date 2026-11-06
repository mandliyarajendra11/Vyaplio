"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { PinError, pinSupported, setPin, verifyPin } from "@/lib/pin";
import { PinPad } from "./PinPad";

/**
 * Set or change the PIN: (current PIN when changing) → new PIN → same PIN again.
 * Only the salted hash is stored (lib/pin.ts).
 */
export function PinSetup({ userId, requireCurrent = false, onDone, id = "pinset" }: { userId: string; requireCurrent?: boolean; onDone: () => void; id?: string }) {
  const t = useTranslations("pin");
  const [phase, setPhase] = useState<"current" | "new" | "confirm">(requireCurrent ? "current" : "new");
  const [first, setFirst] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!pinSupported()) return <p className="rounded-xl bg-brick/10 px-4 py-3 font-semibold text-brick">{t("noCrypto")}</p>;

  const complete = async (pin: string) => {
    setBusy(true);
    try {
      if (phase === "current") {
        const r = await verifyPin(userId, pin);
        if (r.ok) {
          setMsg(null);
          setPhase("new");
        } else setMsg({ text: r.waitMs ? t("wait", { sec: Math.ceil(r.waitMs / 1000) }) : t("wrong", { left: r.attemptsLeft }), tone: "error" });
      } else if (phase === "new") {
        setFirst(pin);
        setMsg(null);
        setPhase("confirm");
      } else if (pin !== first) {
        setFirst("");
        setPhase("new");
        setMsg({ text: t("mismatch"), tone: "error" });
      } else {
        await setPin(userId, pin);
        onDone();
      }
    } catch (e) {
      setMsg({ text: e instanceof PinError && e.code === "noCrypto" ? t("noCrypto") : String(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <PinPad
      key={phase}
      id={id}
      label={phase === "current" ? t("enterCurrent") : phase === "new" ? t("enterNew") : t("confirmNew")}
      onComplete={complete}
      busy={busy}
      message={msg?.text}
      tone={msg?.tone}
    />
  );
}
