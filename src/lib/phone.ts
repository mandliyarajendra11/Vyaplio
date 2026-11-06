/** India pilot: accept ten digits, +91 or 91 prefix, including Hindi numerals. */
export function indiaPhone(input: string): string | null {
  const ascii = input.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
  const digits = ascii.replace(/[\s()+-]/g, "");
  const local = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null;
}

export const phoneLocalAccount = (phone: string) => `phone-${phone.replace(/\D/g, "")}@local.vyaplio`;
