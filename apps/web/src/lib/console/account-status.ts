// Shared, presentation-free helpers for upstream account health badges.

export type AccountStatusInput = {
  quotaStatus?: string;
  quotaStatusReason?: string;
  autoLoginStatus?: string;
  autoLoginStep?: string;
  autoLoginError?: string;
};

export type AccountStatusBadge = {
  tone: "green" | "yellow" | "red";
  label: string;
};

const ERROR_REASON_LABELS: Record<string, string> = {
  invalid_grant: "\u9274\u6743\u5931\u6548",
  verification_required: "\u9700\u8981\u9a8c\u8bc1",
  consecutive_errors: "\u8fde\u7eed\u62a5\u9519",
};

const COOLING_REASON_LABELS: Record<string, string> = {
  capacity: "\u5bb9\u91cf\u51b7\u5374\u4e2d",
  quota: "\u989d\u5ea6\u6062\u590d\u4e2d",
};

const CODEX_AUTO_LOGIN_STEP_LABELS: Record<string, string> = {
  starting: "\u51c6\u5907\u4e2d",
  opening_authorize_url: "\u6253\u5f00\u6388\u6743\u9875",
  choose_account: "\u5207\u6362\u8d26\u53f7",
  email: "\u586b\u5199\u90ae\u7bb1",
  password: "\u586b\u5199\u5bc6\u7801",
  creating_adspower_profile: "\u521b\u5efa AdsPower \u73af\u5883",
  email_code_polling: "\u90ae\u7bb1\u9a8c\u8bc1\u7801",
  email_code_fill: "\u586b\u5199\u90ae\u7bb1\u9a8c\u8bc1\u7801",
  totp: "\u52a8\u6001\u9a8c\u8bc1\u7801",
  add_phone: "\u586b\u5199\u624b\u673a\u53f7",
  sms_polling: "\u77ed\u4fe1\u9a8c\u8bc1\u7801",
  sms_fill: "\u586b\u5199\u77ed\u4fe1\u9a8c\u8bc1\u7801",
  consent: "\u786e\u8ba4\u6388\u6743",
  got_code: "\u62ff\u5230\u6388\u6743\u7801",
  exchanging_token: "\u6362\u53d6 token",
  completed: "\u5b8c\u6210",
};

function codexAutoLoginStepLabel(step?: string) {
  if (!step) return "\u4e0a\u53f7";
  return CODEX_AUTO_LOGIN_STEP_LABELS[step] || step;
}

/**
 * Bucket accounts into healthy vs not-ok, grouping the not-ok ones by reason.
 * Any non-"ok" status counts as not-ok.
 */
export function accountHealthSummary(
  accounts: AccountStatusInput[],
): { okCount: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  let okCount = 0;
  for (const account of accounts) {
    const status = account.quotaStatus || "ok";
    if (status === "ok") {
      okCount++;
      continue;
    }
    const reason = account.quotaStatusReason || status || "unknown";
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { okCount, reasons };
}

export function accountStatusLabel(
  quotaStatus?: string,
  quotaStatusReason?: string,
  meta?: Pick<AccountStatusInput, "autoLoginStatus" | "autoLoginStep" | "autoLoginError">,
): AccountStatusBadge {
  if (meta?.autoLoginStatus === "running") {
    return {
      tone: "yellow",
      label: `\u4e0a\u53f7\u4e2d \u00b7 ${codexAutoLoginStepLabel(meta.autoLoginStep)}`,
    };
  }
  if (meta?.autoLoginStatus === "failed") {
    return {
      tone: "red",
      label: `\u4e0a\u53f7\u5931\u8d25 \u00b7 ${codexAutoLoginStepLabel(meta.autoLoginStep)}`,
    };
  }

  const status = quotaStatus || "ok";
  const reason = quotaStatusReason || "";
  if (status === "error") {
    return {
      tone: "red",
      label: `\u5df2\u5931\u6548\u00b7${ERROR_REASON_LABELS[reason] || "\u8fde\u7eed\u62a5\u9519"}`,
    };
  }
  if (status === "exhausted" || status === "cooling") {
    return {
      tone: "yellow",
      label: COOLING_REASON_LABELS[reason] || "\u989d\u5ea6\u6062\u590d\u4e2d",
    };
  }
  return { tone: "green", label: "\u6b63\u5e38" };
}
