import type { Sale } from "./db";

/** Short bill number shown on bills and in WhatsApp: first 6 letters/digits of the id, upper case. */
export const billNo = (s: Pick<Sale, "id">) => s.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 6).toUpperCase();
