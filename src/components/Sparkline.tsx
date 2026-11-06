export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const w = 220;
  const h = 44;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / Math.max(values.length - 1, 1)) * (w - 8) + 4, h - 6 - (v / max) * (h - 14)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} role="img" aria-hidden="true">
      <path d={`${d} L${w - 4},${h} L4,${h} Z`} fill="rgba(14,90,94,0.08)" />
      <path d={d} fill="none" stroke="var(--teal)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {last && <circle cx={last[0]} cy={last[1]} r="4.5" fill="var(--mustard)" stroke="var(--teal-deep)" strokeWidth="1.5" />}
    </svg>
  );
}
