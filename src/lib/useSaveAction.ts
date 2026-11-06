"use client";

import { useRef, useState } from "react";

/** Lock synchronously, before React renders the disabled button. */
export function useSaveAction() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  return { busy, failed, run };
}
