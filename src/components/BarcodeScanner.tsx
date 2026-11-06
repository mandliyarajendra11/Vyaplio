"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";

interface Detector {
  detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts?: { formats?: string[] }) => Detector;

function getDetector(): DetectorCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { BarcodeDetector?: DetectorCtor };
  return w.BarcodeDetector && "mediaDevices" in navigator ? w.BarcodeDetector : undefined;
}

/** Camera barcode scan via BarcodeDetector; falls back to typing the number. */
export function BarcodeScanner({ open, onClose, onDetected }: { open: boolean; onClose: () => void; onDetected: (code: string) => void }) {
  const t = useTranslations("scan");
  const videoRef = useRef<HTMLVideoElement>(null);
  const cbRef = useRef(onDetected);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const Ctor = getDetector();

  useEffect(() => {
    cbRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    if (!open || !Ctor) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    let detector: Detector;
    try {
      detector = new Ctor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"] });
    } catch {
      detector = new Ctor();
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        void v.play();
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(v);
            if (codes[0]?.rawValue) {
              cbRef.current(codes[0].rawValue);
              return;
            }
          } catch {
            /* frame not ready */
          }
          timer = window.setTimeout(tick, 300);
        };
        timer = window.setTimeout(tick, 400);
      })
      .catch(() => setError(t("cameraError")));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [open, Ctor, t]);

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (manual.trim()) cbRef.current(manual.trim());
    setManual("");
  };

  return (
    <Sheet open={open} onClose={onClose} title={t("title")}>
      {Ctor && !error ? (
        <div className="overflow-hidden rounded-2xl bg-ink">
          <video ref={videoRef} className="aspect-[4/3] w-full object-cover" muted playsInline />
          <p className="px-4 py-3 text-center text-paper">{t("point")}</p>
        </div>
      ) : (
        <p className="rounded-2xl bg-mustard-soft px-4 py-3 font-semibold">{error ?? t("unsupported")}</p>
      )}
      <form onSubmit={submitManual} className="mt-4 flex gap-2">
        <input
          className="input num"
          inputMode="numeric"
          placeholder={t("manual")}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          aria-label={t("manual")}
        />
        <button className="btn btn-teal shrink-0" type="submit">
          {t("use")}
        </button>
      </form>
    </Sheet>
  );
}
