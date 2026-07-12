const FALLBACK = "公平限额已用完，请等待额度恢复";

const MESSAGES: Record<string, string> = {
  primary_exhausted: "5 小时额度已用完，请等待额度恢复",
  weekly_exhausted: "周额度已用完，请等待额度恢复",
  account_recovering: "上游额度恢复中，请稍后重试",
};

export function fairShareDenialMessage(reason?: string): string {
  return MESSAGES[String(reason || "")] || FALLBACK;
}
