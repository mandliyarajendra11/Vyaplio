"use client";

import { useTranslations } from "next-intl";
import { IconScan, IconSearch, IconX } from "./Icons";
import { VoiceButton, type VoiceOutcome } from "./VoiceButton";

export function SearchBar({
  value,
  onChange,
  placeholder,
  onScan,
  onVoice,
  onVoicePick,
  onVoiceAdd,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onScan?: () => void;
  /** Spoken text (best guess first); default: put it in the search box. */
  onVoice?: (alternatives: string[]) => VoiceOutcome;
  onVoicePick?: (id: string) => void;
  onVoiceAdd?: (text: string) => void;
}) {
  const t = useTranslations("scan");
  return (
    <div className="flex items-center gap-2">
      <label className="relative flex-1">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-soft" />
        <input
          type="search"
          className="input pl-11 pr-11"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={placeholder}
          enterKeyHint="search"
        />
        {value && (
          <button type="button" onClick={() => onChange("")} className="icon-btn absolute top-1/2 right-0.5 -translate-y-1/2 text-ink-soft" aria-label="clear">
            <IconX width={20} height={20} />
          </button>
        )}
      </label>
      <VoiceButton onResult={onVoice ?? ((alts) => onChange(alts[0] ?? ""))} onPick={onVoicePick} onAdd={onVoiceAdd} />
      {onScan && (
        <button type="button" onClick={onScan} className="icon-btn shrink-0 bg-paper-2 text-teal-deep" aria-label={t("button")} title={t("button")}>
          <IconScan />
        </button>
      )}
    </div>
  );
}

export function matches(q: string, ...fields: (string | undefined)[]) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return fields.some((f) => f && f.toLowerCase().includes(s));
}
