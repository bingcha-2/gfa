export const QUEUE_NAMES = {
  invite: "family-invite-queue",
  remove: "family-remove-queue",
  replace: "family-replace-queue",
  sync: "family-sync-queue",
  health: "account-health-queue",
  retry: "manual-retry-queue"
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const TASK_TYPES = {
  inviteMember: "INVITE_MEMBER",
  removeMember: "REMOVE_MEMBER",
  replaceMember: "REPLACE_MEMBER",
  syncFamilyGroup: "SYNC_FAMILY_GROUP",
  healthCheckAccount: "HEALTH_CHECK_ACCOUNT"
} as const;

export type TaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];

export type InviteMemberPayload = {
  taskId?: string;
  orderId?: string;
  familyGroupId: string;
  accountId: string;
  userEmail: string;
};

export type ReplaceMemberPayload = {
  taskId?: string;
  orderId?: string;
  familyGroupId: string;
  accountId: string;
  targetMemberEmail: string;
  newUserEmail: string;
};

export type RemoveMemberPayload = {
  taskId?: string;
  familyGroupId: string;
  accountId: string;
  memberEmail: string;
};

export type SyncFamilyGroupPayload = {
  taskId?: string;
  familyGroupId: string;
  accountId: string;
};

export type HealthCheckAccountPayload = {
  taskId?: string;
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
