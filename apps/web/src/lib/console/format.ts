// Shared formatting + status maps for the 用户管理 (客户业务) console pages.

export function fmtYuan(cents: number): string {
  return "¥" + (cents / 100).toFixed(2);
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: "待支付",
  PAID: "已支付",
  FAILED: "失败",
  REFUNDED: "已退款",
  EXPIRED: "已过期",
};

export const SUB_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "生效中",
  EXPIRED: "已过期",
  CANCELLED: "已取消",
};

export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "正常",
  DISABLED: "已封禁",
};

export const PAY_CHANNEL_LABEL: Record<string, string> = {
  ALIPAY: "支付宝",
  WXPAY: "微信",
  GRANT: "管理员授予",
  ACTIVATION_CODE: "激活码",
  CREDIT: "余额抵扣",
};

export const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: "待处理",
  ANSWERED: "已回复",
  CLOSED: "已关闭",
};

export const REFERRAL_STATUS_LABEL: Record<string, string> = {
  PENDING: "待发放",
  GRANTED: "已发放",
  REVOKED: "已撤销",
};
