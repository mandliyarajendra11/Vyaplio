"use client";

import { useCallback, useRef, useState } from "react";
import type { SaleDraft } from "./db";
import { emptySaleDraft, saveSaleDraft } from "./saleDraft";

export function useSaleDraft(initial: SaleDraft) {
  const [draft, setDraft] = useState(initial);
  const current = useRef(initial);
  const revision = useRef(0);
  const [status, setStatus] = useState<"saved" | "saving" | "failed">("saved");

  const update = useCallback((change: (previous: SaleDraft) => SaleDraft) => {
    const next = change(current.current);
    current.current = next;
    setDraft(next);
    const version = ++revision.current;
    setStatus("saving");
    void saveSaleDraft(next).then(() => {
      if (revision.current === version) setStatus("saved");
    }, () => {
      if (revision.current === version) setStatus("failed");
    });
  }, []);

  const resetAfterSale = () => {
    // recordSale has already removed the draft in its database transaction.
    ++revision.current;
    const next = emptySaleDraft(current.current.shopId);
    current.current = next;
    setDraft(next);
    setStatus("saved");
  };

  return { draft, update, status, resetAfterSale };
}
