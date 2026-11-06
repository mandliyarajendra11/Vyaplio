/**
 * Plain-text recovery card: what someone needs to get the shop back on a new phone.
 * Holds no secrets — never a password, PIN, backup password, UPI ID or any key.
 */
type T = (key: string, values?: Record<string, string | number>) => string;

export interface RecoveryCardInput {
  shopName: string;
  shopId: string;
  ownerName?: string;
  accountEmail?: string;
  cloudEmail?: string | null;
  lastBackup?: string | null; // already formatted date
  lastBackupVia?: "file" | "cloud" | null;
}

export function recoveryCardLines(t: T, c: RecoveryCardInput): string[] {
  return [
    t("cardTitle"),
    `${t("cardShop")}: ${c.shopName}${c.ownerName ? ` (${c.ownerName})` : ""}`,
    `${t("cardShopId")}: ${c.shopId}`,
    `${t("cardAccount")}: ${c.accountEmail || "—"}`,
    `${t("cardCloud")}: ${c.cloudEmail ? c.cloudEmail : t("cardCloudNone")}`,
    `${t("cardBackups")}: ${t("cardBackupsWhere")}`,
    `${t("cardLast")}: ${c.lastBackup ? `${c.lastBackup} · ${t(c.lastBackupVia === "cloud" ? "cardViaCloud" : "cardViaFile")}` : t("cardNever")}`,
    "",
    `1. ${t("cardStep1")}`,
    `2. ${c.cloudEmail ? t("cardStep2Cloud") : t("cardStep2File")}`,
    `3. ${t("cardStep3")}`,
    "",
    t("cardNoSecrets"),
  ];
}

export const recoveryCardText = (t: T, c: RecoveryCardInput) => recoveryCardLines(t, c).join("\n");
