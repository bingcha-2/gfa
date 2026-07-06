import { accountStatusLabel } from "@/lib/console/account-status";

const STATUS_DOT: Record<string, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
};

export function AccountStatusCell({
  account,
}: {
  account: {
    quotaStatus?: string;
    quotaStatusReason?: string;
    autoLoginStatus?: string;
    autoLoginStep?: string;
    autoLoginError?: string;
  };
}) {
  const badge = accountStatusLabel(account.quotaStatus, account.quotaStatusReason, {
    autoLoginStatus: account.autoLoginStatus,
    autoLoginStep: account.autoLoginStep,
    autoLoginError: account.autoLoginError,
  });

  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[badge.tone]}`} />
      <span className={badge.tone === "red" ? "font-medium text-red-600" : "text-muted-foreground"}>
        {badge.label}
      </span>
    </span>
  );
}
