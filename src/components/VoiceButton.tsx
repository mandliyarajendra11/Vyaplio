"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getRecognitionCtor, startVoice, voiceLangFor, type VoiceError, type VoiceLang, type VoiceSession } from "@/lib/voice";
import { IconMic } from "./Icons";
import { Sheet } from "./Sheet";

/** What the page did with the words: nothing to show (sheet closes) or "no such product". */
export type VoiceOutcome = void | { kind: "nomatch"; text: string; closest: { id: string; label: string }[] };

const LANG_KEY = "dm.voiceLang";
const noop = () => () => {};
// Only on the client (the server render has no recogniser), without a hydration mismatch.
const useHasVoice = () => useSyncExternalStore(noop, () => !!getRecognitionCtor(), () => false);

type State =
  | { phase: "listening"; interim: string }
  | { phase: "error"; error: VoiceError }
  | { phase: "nomatch"; text: string; closest: { id: string; label: string }[] };

/**
 * Mic button + sheet: Web Speech recognition in Hindi (hi-IN) or English (en-IN), following the
 * app language with a quick toggle; shows what it hears while you speak and explains failures.
 * Hidden only when the browser has no speech recognition at all.
 */
export function VoiceButton({ onResult, onPick, onAdd }: { onResult: (alternatives: string[]) => VoiceOutcome; onPick?: (id: string) => void; onAdd?: (text: string) => void }) {
  const t = useTranslations("voice");
  const locale = useLocale();
  const has = useHasVoice();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<VoiceLang>(() => voiceLangFor(locale));
  const [state, setState] = useState<State>({ phase: "listening", interim: "" });
  const [offline, setOffline] = useState(false);
  const session = useRef<VoiceSession | null>(null);
  const resultRef = useRef(onResult);
  useEffect(() => {
    resultRef.current = onResult;
  }, [onResult]);
  useEffect(() => () => session.current?.abort(), []);

  const listen = useCallback((l: VoiceLang) => {
    const Ctor = getRecognitionCtor();
    session.current?.abort();
    setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    setState({ phase: "listening", interim: "" });
    if (!Ctor) return setState({ phase: "error", error: "unsupported" });
    const s = startVoice(Ctor, l, {
      onInterim: (interim) => setState((st) => (st.phase === "listening" ? { phase: "listening", interim } : st)),
      onFinal: (alts) => {
        const out = resultRef.current(alts);
        if (out && out.kind === "nomatch") setState({ phase: "nomatch", text: out.text, closest: out.closest });
        else setOpen(false);
      },
      onError: (error) => setState({ phase: "error", error }),
      onEnd: () => {
        if (session.current === s) session.current = null;
      },
    });
    session.current = s;
  }, []);

  if (!has) return null;

  const begin = () => {
    let l = voiceLangFor(locale);
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === "hi-IN" || saved === "en-IN") l = saved;
    } catch {
      /* private mode */
    }
    setLang(l);
    setOpen(true);
    listen(l);
  };
  const switchLang = (l: VoiceLang) => {
    setLang(l);
    try {
      window.localStorage.setItem(LANG_KEY, l);
    } catch {
      /* private mode */
    }
    listen(l);
  };
  const close = () => {
    session.current?.abort();
    session.current = null;
    setOpen(false);
  };
  const listening = open && state.phase === "listening";

  return (
    <>
      <button
        type="button"
        onClick={begin}
        aria-label={t("start")}
        title={t("start")}
        className={`icon-btn shrink-0 ${listening ? "bg-brick text-paper" : "bg-paper-2 text-teal-deep"}`}
      >
        <IconMic />
      </button>
      <Sheet open={open} onClose={close} title={t("title")}>
        <div className="space-y-4" data-testid="voice-sheet">
          <div className="flex items-center gap-2" role="group" aria-label={t("langLabel")}>
            <span className="text-sm text-ink-soft">{t("langLabel")}</span>
            {(["hi-IN", "en-IN"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={lang === l}
                onClick={() => switchLang(l)}
                className={`min-h-12 rounded-full px-4 font-semibold ${lang === l ? "bg-teal text-paper" : "bg-paper-2 text-ink"}`}
              >
                {l === "hi-IN" ? "हिंदी" : "English"}
              </button>
            ))}
          </div>

          {offline && state.phase === "listening" && <p className="rounded-xl bg-mustard/20 px-4 py-2 text-sm font-semibold text-mustard-ink">{t("offlineNote")}</p>}

          {state.phase === "listening" && (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <span className="grid size-20 animate-pulse place-items-center rounded-full bg-brick text-paper">
                <IconMic width={36} height={36} />
              </span>
              <p className="text-lg font-semibold">{t("listening")}</p>
              <p aria-live="polite" data-testid="voice-interim" className="min-h-8 text-2xl font-bold break-words text-teal-deep">
                {state.interim || <span className="text-base font-normal text-ink-soft">{t("hint")}</span>}
              </p>
              <button type="button" className="btn btn-ghost" onClick={() => session.current?.stop()}>
                {t("stop")}
              </button>
            </div>
          )}

          {state.phase === "error" && (
            <div role="alert" className="space-y-2">
              <p className="text-lg font-bold text-brick">{t(`err_${state.error}`)}</p>
              <p className="text-ink-soft">{t(`help_${state.error}`)}</p>
              <div className="flex gap-2 pt-2">
                {state.error !== "unsupported" && (
                  <button type="button" className="btn btn-primary flex-1" onClick={() => listen(lang)}>
                    {t("retry")}
                  </button>
                )}
                <button type="button" className="btn btn-ghost flex-1" onClick={close}>
                  {t("typeInstead")}
                </button>
              </div>
            </div>
          )}

          {state.phase === "nomatch" && (
            <div role="alert" className="space-y-3">
              <p className="text-lg font-bold">{t("noMatch", { text: state.text })}</p>
              {state.closest.length > 0 && onPick && (
                <div>
                  <p className="text-sm text-ink-soft">{t("closest")}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {state.closest.map((c) => (
                      <button key={c.id} type="button" className="min-h-12 rounded-full bg-paper-2 px-4 font-semibold" onClick={() => { onPick(c.id); close(); }}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {onAdd ? (
                  <button type="button" className="btn btn-ghost flex-1" onClick={() => { onAdd(state.text); close(); }}>
                    {t("addProduct", { text: state.text })}
                  </button>
                ) : (
                  <Link href={`/stock?add=${encodeURIComponent(state.text)}`} className="btn btn-ghost flex-1" onClick={close}>
                    {t("addProduct", { text: state.text })}
                  </Link>
                )}
                <button type="button" className="btn btn-primary flex-1" onClick={() => listen(lang)}>
                  {t("retry")}
                </button>
              </div>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}
