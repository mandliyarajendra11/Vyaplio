export function Wordmark({ size = "lg", sub = true }: { size?: "sm" | "lg" | "xl"; sub?: boolean }) {
  // Shrinks with the screen (320px phones, large system font) and keeps the short brand name together.
  const cls = size === "xl" ? "text-[clamp(2.4rem,13vw,3.1rem)] sm:text-[3.8rem]" : size === "lg" ? "text-[clamp(2rem,11vw,2.4rem)]" : "text-2xl";
  return (
    <div className="leading-none">
      <p className={`font-brand font-semibold tracking-[-0.035em] text-teal-deep ${cls}`}>
        Vyap
        <span className="italic text-mustard-strong">lio</span>
      </p>
      {sub && (
        <p className="mt-1.5 font-deva text-lg font-semibold tracking-wide text-ink-soft">
          व्याप्लियो <span className="mx-1 text-mustard-ink">·</span> हर दुकान का काम आसान
        </p>
      )}
    </div>
  );
}
