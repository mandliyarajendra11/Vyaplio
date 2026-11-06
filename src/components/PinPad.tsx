"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

/**
 * Big 4-digit keypad (also takes the hardware keyboard). Calls onComplete with the PIN once 4
 * digits are in, then clears itself. The digits are never shown, only filled dots.
 */
export function PinPad({ label, onComplete, busy = false, message, tone = "info", id = "pin" }: {
  label: string;
  onComplete: (pin: string) => unknown | Promise<unknown>;
  busy?: boolean;
  message?: string | null;
  tone?: "info" | "error";
  id?: string;
}) {
  const t = useTranslations("pin");
  const value = useRef("");
  const [len, setLen] = useState(0);
  const press = useCallback(
    (k: string) => {
      if (busy) return;
      if (k === "del") value.current = value.current.slice(0, -1);
      else if (/^\d$/.test(k) && value.current.length < 4) value.current += k;
      setLen(value.current.length);
      if (value.current.length === 4) {
        const pin = value.current;
        value.current = "";
        void Promise.resolve(onComplete(pin)).finally(() => setLen(0));
      }
    },
    [busy, onComplete],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("del");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <div className="mx-auto w-full max-w-[22rem]" data-testid={`${id}-pad`}>
      <p className="text-center text-xl font-bold" id={`${id}-label`}>
        {label}
      </p>
      <div className="mt-4 flex justify-center gap-4" role="img" aria-label={t("dots", { k: len, n: 4 })} data-testid={`${id}-dots`} data-filled={len}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-5 w-5 rounded-full border-2 border-teal-deep ${i < len ? "bg-teal-deep" : "bg-transparent"}`} />
        ))}
      </div>
      <p role={tone === "error" ? "alert" : "status"} className={`mt-3 min-h-[3rem] text-center font-semibold ${tone === "error" ? "text-brick" : "text-ink-soft"}`}>
        {message}
      </p>
      <div className="grid grid-cols-3 gap-3" aria-labelledby={`${id}-label`}>
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => press(k)}
              aria-label={k === "del" ? t("del") : k}
              data-key={k}
              className={`num min-h-16 rounded-2xl text-3xl font-bold ${k === "del" ? "text-lg text-ink-soft" : "border-2 border-line bg-card text-ink active:bg-paper-2"} disabled:cursor-not-allowed disabled:bg-paper-2`}
            >
              {k === "del" ? "⌫" : k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
