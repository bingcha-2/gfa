export const QUEUE_NAMES = {
  invite: "family-invite-queue",
  remove: "family-remove-queue",
  replace: "family-replace-queue",
  sync: "family-sync-queue",
  health: "account-health-queue",
  retry: "manual-retry-queue",
  automation: "automation-queue"
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const TASK_TYPES = {
  inviteMember: "INVITE_MEMBER",
  removeMember: "REMOVE_MEMBER",
  replaceMember: "REPLACE_MEMBER",
  syncFamilyGroup: "SYNC_FAMILY_GROUP",
  healthCheckAccount: "HEALTH_CHECK_ACCOUNT",
  oauthAuthorize: "OAUTH_AUTHORIZE",
  acceptInvite: "ACCEPT_INVITE"
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
  /** Audit trail: 'ADMIN_REPLACE' | 'SWAP_REQUEST' */
  reason?: string;
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

export type AutomationPayload = {
  taskId?: string;
  action: "oauth" | "accept-invite";
  /** Account credentials — passed from client, not stored server-side */
  credentials: {
    email: string;
    password: string;
    recoveryEmail?: string;
    totpSecret?: string;
  };
  /** OAuth-specific: redirect URI for code exchange */
  redirectUri?: string;
  /** OAuth-specific: state parameter */
  oauthState?: string;
};

// Redis key prefixes used by worker infrastructure
export const REDIS_KEYS = {
  profileLock: "gfa:lock:profile:",
  workerHeartbeat: "gfa:heartbeat:",
  browserPool: "gfa:pool:profile:",
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

/**
 * Default BullMQ job options for all task queues.
 * Spread into every queue.add() call so TRANSIENT failures auto-retry.
 *
 * - attempts: 3 total tries (1 initial + 2 retries)
 * - backoff: exponential, 30s → 60s → 120s
 */
export const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const;
