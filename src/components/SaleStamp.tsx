/** Rubber-stamp "sold" mark – the sale-success transition. */
export function SaleStamp({ label }: { label: string }) {
  return (
    <div className="sale-stamp mx-auto inline-flex items-center gap-3 rounded-2xl border-[3px] border-leaf px-5 py-2 text-leaf">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="check-draw" d="M4.5 12.5l5 5L19.5 7" />
      </svg>
      <span className="font-brand text-3xl font-bold tracking-tight uppercase">{label}</span>
    </div>
  );
}
