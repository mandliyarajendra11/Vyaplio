/** wa.me deep link. Indian 10-digit numbers get the 91 country code. */
export function waLink(text: string, phone?: string) {
  let p = (phone ?? "").replace(/\D/g, "");
  if (p.length === 10) p = "91" + p;
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}
