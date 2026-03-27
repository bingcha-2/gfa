type StatusTone = "emerald" | "amber" | "crimson" | "stone" | "sky";

const toneMap: Record<string, StatusTone> = {
  ACTIVE: "emerald",
  HEALTHY: "emerald",
  SUCCESS: "emerald",
  COMPLETED: "emerald",
  INVITE_SENT: "emerald",
  REPLACED_AND_INVITE_SENT: "emerald",
  ACCEPTED: "emerald",
  UNUSED: "sky",
  RESERVED: "amber",
  PENDING: "amber",
  RUNNING: "amber",
  WAIT_USER_ACCEPT: "amber",
  TASK_QUEUED: "amber",
  TASK_RUNNING: "amber",
  CODE_VERIFIED: "sky",
  GROUP_ASSIGNED: "sky",
  CREATED: "sky",
  MANUAL_REVIEW: "stone",
  MANUAL_ONLY: "stone",
  LOGIN_REQUIRED: "stone",
  VERIFICATION_REQUIRED: "stone",
  DISABLED: "crimson",
  FAILED: "crimson",
  FAILED_FINAL: "crimson",
  FAILED_RETRYABLE: "crimson",
  EXPIRED: "crimson",
  REMOVED: "crimson",
  CANCELLED: "crimson",
  RISKY: "amber",
  SENT: "sky",
  USED: "stone"
};

// Chinese display labels for status values
const labelMap: Record<string, string> = {
  // Account status
  HEALTHY: "正常",
  LOGIN_REQUIRED: "需登录",
  VERIFICATION_REQUIRED: "需验证",
  DISABLED: "已停用",
  // Family group status
  ACTIVE: "活跃",
  MANUAL_ONLY: "仅手动",
  // Order status
  PENDING: "排队中",
  RUNNING: "执行中",
  TASK_QUEUED: "任务排队",
  TASK_RUNNING: "任务执行中",
  CODE_VERIFIED: "卡密已验证",
  GROUP_ASSIGNED: "已分组",
  INVITE_SENT: "邀请已发送",
  WAIT_USER_ACCEPT: "等待接受",
  COMPLETED: "已完成",
  FAILED: "失败",
  EXPIRED: "已过期",
  CANCELLED: "已取消",
  MANUAL_REVIEW: "人工处理",
  REPLACED_AND_INVITE_SENT: "已换号并邀请",
  // Task status
  FAILED_FINAL: "最终失败",
  FAILED_RETRYABLE: "可重试",
  // Task type
  INVITE_MEMBER: "邀请成员",
  REMOVE_MEMBER: "移除成员",
  REPLACE_MEMBER: "替换成员",
  SYNC_FAMILY_GROUP: "同步家庭组",
  HEALTH_CHECK_ACCOUNT: "健康检查",
  // Redeem code status
  UNUSED: "未使用",
  USED: "已使用",
  RESERVED: "已占用",
  // Member status
  ACCEPTED: "已接受",
  REMOVED: "已移除",
  SENT: "已发送",
  CREATED: "已创建",
  // Subscription status
  SUSPENDED: "已暂停",
  // Generic
  SUCCESS: "成功",
  RISKY: "风险",
  // Role
  ADMIN: "管理员",
  OPERATIONS: "运维",
  SUPPORT: "客服",
  OWNER: "母号",
  MEMBER: "成员",
  // TOTP
  TOTP: "已设置",
  "No TOTP": "未设置",
  // Product
  GOOGLE_ONE: "Google One",
};

type StatusBadgeProps = {
  value: string;
  tone?: StatusTone;
};

export function StatusBadge({ value, tone }: StatusBadgeProps) {
  const resolvedTone = tone ?? toneMap[value] ?? "stone";
  const label = labelMap[value] ?? value.replaceAll("_", " ");

  return (
    <span className={`status-badge status-${resolvedTone}`}>
      {label}
    </span>
  );
}
