import { accountStatusLabel } from "@/lib/account-status";

const STATUS_DOT: Record<string, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
};

/**
 * Renders an upstream account's runtime health as a colored dot + label.
 * Dead (error) accounts are red and bold so they stand out in the table.
 */
export function AccountStatusCell({
  account,
}: {
  account: { quotaStatus?: string; quotaStatusReason?: string };
}) {
  const badge = accountStatusLabel(account.quotaStatus, account.quotaStatusReason);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[badge.tone]}`} />
      <span className={badge.tone === "red" ? "text-red-600 font-medium" : "text-muted-foreground"}>
        {badge.label}
      </span>
    </span>
  );
}
