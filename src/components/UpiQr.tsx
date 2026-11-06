"use client";

import { useMemo } from "react";
import { encode } from "uqr";

/** QR code drawn as one SVG path (bundled encoder, works offline). */
export function QrCode({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, n: qr.size };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="upi-qr"
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="h-auto max-w-full rounded-xl bg-white"
    >
      <path d={path} fill="#111" />
    </svg>
  );
}
