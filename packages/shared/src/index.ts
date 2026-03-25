export const QUEUE_NAMES = {
  invite: "family-invite-queue",
  replace: "family-replace-queue",
  sync: "family-sync-queue",
  health: "account-health-queue",
  retry: "manual-retry-queue"
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const TASK_TYPES = {
  inviteMember: "INVITE_MEMBER",
  replaceMember: "REPLACE_MEMBER",
  syncFamilyGroup: "SYNC_FAMILY_GROUP",
  healthCheckAccount: "HEALTH_CHECK_ACCOUNT"
} as const;

export type TaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];

export type InviteMemberPayload = {
  orderId?: string;
  familyGroupId: string;
  accountId: string;
  userEmail: string;
};

export type ReplaceMemberPayload = {
  orderId?: string;
  familyGroupId: string;
  accountId: string;
  targetMemberEmail: string;
  newUserEmail: string;
};

export type SyncFamilyGroupPayload = {
  familyGroupId: string;
  accountId: string;
};

export type HealthCheckAccountPayload = {
  accountId: string;
};

// Redis key prefixes used by worker infrastructure
export const REDIS_KEYS = {
  profileLock: "gfa:lock:profile:",
  workerHeartbeat: "gfa:heartbeat:",
} as const;

// Task status values matching Prisma TaskStatus enum
export type TaskStatusValue =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "INVITE_SENT"
  | "REPLACED_AND_INVITE_SENT"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "MANUAL_REVIEW"
  | "CANCELLED";
