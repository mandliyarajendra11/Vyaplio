/**
 * Web Speech recognition wrapper (no React, so it can be tested with a mocked recogniser).
 * Language follows the app (hi-IN / en-IN), interim text is reported while speaking, and every
 * failure is mapped to a reason the mic sheet can explain in Hindi / English.
 */

export type VoiceLang = "hi-IN" | "en-IN";

export type VoiceError =
  | "unsupported" // the browser has the API but refuses to run it (Brave, some WebViews, http)
  | "permission" // microphone permission denied
  | "noSpeech" // nothing heard
  | "mic" // no microphone / it is busy
  | "network" // the recogniser's server could not be reached
  | "offline" // …and the phone is offline: Chrome's recogniser usually needs internet
  | "language" // this language is not available on the phone
  | "failed";

interface Alternative {
  transcript: string;
}
interface Result {
  readonly isFinal?: boolean;
  readonly length: number;
  [i: number]: Alternative;
}
export interface RecognitionEvent {
  resultIndex?: number;
  results: { readonly length: number; [i: number]: Result };
}
export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string; message?: string }) => void) | null;
}
export type RecognitionCtor = new () => Recognition;

/** The browser's recogniser, or undefined when there is none (then the mic button is hidden). */
export function getRecognitionCtor(w: unknown = typeof window === "undefined" ? undefined : window): RecognitionCtor | undefined {
  if (!w) return undefined;
  const x = w as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return x.SpeechRecognition ?? x.webkitSpeechRecognition;
}

export const voiceLangFor = (locale: string): VoiceLang => (locale === "en" ? "en-IN" : "hi-IN");

export function mapVoiceError(code: string | undefined, online: boolean): VoiceError {
  switch (code) {
    case "not-allowed":
    case "permission-denied":
      return "permission";
    case "service-not-allowed":
      return "unsupported";
    case "no-speech":
      return "noSpeech";
    case "audio-capture":
      return "mic";
    case "network":
      return online ? "network" : "offline";
    case "language-not-supported":
    case "bad-grammar":
      return "language";
    default:
      return online ? "failed" : "offline";
  }
}

/** Drop the full stop / danda the recogniser adds. */
export const cleanTranscript = (t: string) => t.replace(/[।.?!]+\s*$/u, "").replace(/\s+/g, " ").trim();

export interface VoiceHandlers {
  onInterim?: (text: string) => void;
  /** Final text, best guess first (up to 3 alternatives). */
  onFinal: (alternatives: string[]) => void;
  onError: (e: VoiceError) => void;
  /** Always called once at the end (after onFinal / onError). */
  onEnd?: () => void;
}

export interface VoiceSession {
  stop: () => void;
  abort: () => void;
}

/**
 * Start one recognition. Exactly one of onFinal / onError fires (aborted sessions fire neither),
 * then onEnd.
 */
export function startVoice(Ctor: RecognitionCtor, lang: VoiceLang, h: VoiceHandlers, isOnline: () => boolean = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false)): VoiceSession {
  let finished = false;
  let aborted = false;
  let error: VoiceError | null = null;
  let finals: string[] = [];
  let interim = "";
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!aborted) {
      const alts = finals.length ? finals : interim ? [interim] : [];
      if (error) h.onError(error);
      else if (alts.length) h.onFinal(alts);
      else h.onError("noSpeech");
    }
    h.onEnd?.();
  };

  let rec: Recognition;
  try {
    rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 3;
  } catch {
    error = "unsupported";
    finish();
    return { stop() {}, abort() {} };
  }
  rec.onresult = (e) => {
    let fin = "";
    let alts: string[] = [];
    let inter = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r || !r.length) continue;
      if (r.isFinal) {
        fin += (fin ? " " : "") + r[0].transcript;
        if (e.results.length === 1) for (let a = 1; a < r.length; a++) alts.push(cleanTranscript(r[a].transcript));
      } else inter += (inter ? " " : "") + r[0].transcript;
    }
    alts = alts.filter(Boolean);
    if (fin) finals = [cleanTranscript(fin), ...alts.filter((a) => a !== cleanTranscript(fin))].filter(Boolean);
    interim = cleanTranscript([fin, inter].filter(Boolean).join(" "));
    if (interim) h.onInterim?.(interim);
  };
  rec.onerror = (e) => {
    if (e?.error === "aborted") {
      aborted = true;
      return;
    }
    error = mapVoiceError(e?.error, isOnline());
  };
  rec.onend = finish;
  try {
    rec.start();
  } catch {
    // InvalidStateError / SecurityError (no https, blocked by policy)
    error = "unsupported";
    finish();
  }
  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        finish();
      }
    },
    abort: () => {
      aborted = true;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
      finish();
    },
  };
}
