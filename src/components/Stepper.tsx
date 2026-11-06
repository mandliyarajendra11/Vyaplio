"use client";

import { formatNum } from "@/lib/money";
import { IconMinus, IconPlus } from "./Icons";

export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  size = "md",
  suffix,
  onEdit,
  editLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  size?: "md" | "lg";
  suffix?: string;
  onEdit?: () => void;
  editLabel?: string;
}) {
  // Width capped by the viewport so the stepper still fits a sheet at 200% text size (height stays ≥ 48px).
  const btn = size === "lg" ? "h-14 w-[min(3.5rem,22vw)]" : "h-12 w-[min(3rem,22vw)]";
  const dec = () => onChange(Math.max(min, Math.round((value - step) * 100) / 100));
  const inc = () => onChange(Math.round((value + step) * 100) / 100);
  return (
    <div className="inline-flex max-w-full items-center gap-1 rounded-2xl border-2 border-line bg-card p-1">
      <button type="button" onClick={dec} className={`${btn} inline-flex shrink-0 items-center justify-center rounded-xl text-ink active:bg-paper-2`} aria-label="-">
        <IconMinus width={22} height={22} />
      </button>
      {onEdit ? <button type="button" onClick={onEdit} aria-label={editLabel} className="num min-h-12 min-w-[min(4rem,22vw)] px-1 text-center [overflow-wrap:anywhere] text-xl font-bold underline decoration-dotted underline-offset-4">
        {formatNum(value)}
        {suffix && <span className="ml-1 text-sm font-semibold text-ink-soft">{suffix}</span>}
      </button> : <span className="num min-w-[min(3.2rem,18vw)] text-center [overflow-wrap:anywhere] text-xl font-bold">
        {formatNum(value)}
        {suffix && <span className="ml-1 text-sm font-semibold text-ink-soft">{suffix}</span>}
      </span>}
      <button type="button" onClick={inc} className={`${btn} inline-flex shrink-0 items-center justify-center rounded-xl bg-teal text-paper active:bg-teal-deep`} aria-label="+">
        <IconPlus width={22} height={22} />
      </button>
    </div>
  );
}
