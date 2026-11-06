"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IconX } from "./Icons";

/** When the keyboard opens (the sheet shrinks with it), bring the field being typed into back into view. */
function keepFocusedFieldVisible(e: React.FocusEvent<HTMLDivElement>) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
  window.setTimeout(() => {
    if (document.activeElement === el) el.scrollIntoView({ block: "nearest" });
  }, 350);
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
      <button aria-label="close" className="fade-in absolute inset-0 bg-teal-deep/55" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[94dvh] w-full max-w-[560px] flex-col rounded-t-[1.75rem] bg-paper shadow-2xl md:rounded-[1.75rem]"
        style={{ backgroundImage: "var(--grain)" }}
      >
        <div className="flex items-start justify-between gap-3 pt-4 pr-[max(1.25rem,env(safe-area-inset-right))] pb-2 pl-[max(1.25rem,env(safe-area-inset-left))]">
          <h2 className="min-w-0 pt-1.5 text-2xl leading-tight font-bold break-words">{title}</h2>
          <button className="icon-btn shrink-0 text-ink-soft hover:bg-paper-2" onClick={onClose} aria-label="close">
            <IconX />
          </button>
        </div>
        <div
          className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-[max(1.25rem,env(safe-area-inset-right))] pl-[max(1.25rem,env(safe-area-inset-left))] ${footer ? "pb-4" : "pb-[calc(1rem+env(safe-area-inset-bottom))]"}`}
          onFocus={keepFocusedFieldVisible}
        >
          {children}
        </div>
        {footer && (
          <div className="border-t border-line pt-3 pr-[max(1.25rem,env(safe-area-inset-right))] pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
