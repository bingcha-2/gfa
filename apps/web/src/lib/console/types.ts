export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  permissions?: string[] | null;
  createdAt?: string;
};

export type AuthSession = {
  accessToken: string;
  user: SessionUser;
};

export type AccountSummary = {
  id: string;
  name: string;
  loginEmail: string;
  adspowerProfileId: string;
  status: string;
  syncError?: string | null;
  riskScore: number;
  dailyOperationCount: number;
  dailyOperationLimit: number;
  hasTotpSecret: boolean;
  loginPassword?: string | null;
  totpSecret?: string | null;
  notes?: string | null;
  lastLoginAt?: string | null;
  lastHealthCheckAt?: string | null;
  subscriptionExpiresAt?: string | null;
  subscriptionStatus?: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: {
    familyGroups: number;
    tasks: number;
  };
};

export type FamilyGroupSummary = {
  id: string;
  groupName: string;
  maxMembers: number;
  memberCount: number;
  availableSlots: number;
  pendingInviteCount: number;
  pendingMemberCount?: number;
  pendingOver3DaysCount?: number;
  status: string;
  syncStatus?: string | null;
  autoAssignEnabled?: boolean;
  riskScore: number;
  createdAt: string;
  lastSyncedAt?: string | null;
  account?: {
    id: string;
    name: string;
    loginEmail: string;
    status?: string;
    syncError?: string | null;
    notes?: string | null;
    subscriptionExpiresAt?: string | null;
    subscriptionStatus?: string | null;
    subscriptionStatusUpdatedAt?: string | null;
    subscriptionPlan?: string | null;
  };
  _count?: {
    members: number;
    invites: number;
  };
};

export type OrderSummary = {
  id: string;
  orderNo: string;
  orderType?: "JOIN" | "SWAP" | "SUBSCRIPTION";
  userEmail: string;
  status: string;
  resultMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  familyGroup?: {
    id: string;
    groupName: string;
  } | null;
  redeemCode?: {
    id: string;
    code: string;
  } | null;
  _count?: {
    tasks: number;
  };
  swapRecords?: Array<{
    id: string;
    oldEmail: string;
    newEmail: string;
    status: string;
    taskId: string | null;
    createdAt: string;
  }>;
};

export type TaskSummary = {
  id: string;
  type: string;
  status: string;
  retryCount: number;
  maxRetryCount: number;
  payload?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  order?: {
    id: string;
    orderNo: string;
    userEmail: string;
  } | null;
  familyGroup?: {
    id: string;
    groupName: string;
  } | null;
  account?: {
    id: string;
    name: string;
  } | null;
};

export type RedeemCodeSummary = {
  id: string;
  code: string;
  product: string;
  codeType: "JOIN_GROUP" | "ACCOUNT_SWAP" | "SUBSCRIPTION";
  status: string;
  redeemedBy?: string | null;
  usedAt?: string | null;
  expiresAt?: string | null;
  validDays?: number | null;
  swapLimit?: number;
  swapWindowHours?: number;
  createdAt: string;
  order?: {
    id: string;
    orderNo: string;
    userEmail: string;
    status: string;
  } | null;
};

export type PublicOrder = {
  orderNo: string;
  userEmail: string;
  status: string;
  resultMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

// ── 用户管理（客户业务）域类型 ────────────────────────────────────
// 后端 console/plans 返回原始 Plan 行：productEntitlements / bucketLimits /
// levels 均为 JSON 字符串（bucketLimits、levels 可空）。
export type ConsolePlan = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationDays: number;
  productEntitlements: string;
  bucketLimits: string | null;
  levels: string | null;
  weight: number;
  deviceLimit: number;
  weeklyTokenLimit: number | null;
  windowMs: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

// 客户列表行（含聚合）
export type ConsoleCustomerListItem = {
  id: string;
  email: string;
  status: string;
  emailVerified: boolean;
  displayName: string | null;
  referralCode: string;
  creditCents: number;
  createdAt: string;
  invitedById: string | null;
  orderCount: number;
  activeSubscriptions: number;
  totalPaidCents: number;
  deviceCount: number;
};
export type ConsoleCustomerList = {
  customers: ConsoleCustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ConsoleSubscriptionLite = {
  id: string;
  status: string;
  startsAt: string;
  expiresAt: string | null;
  productEntitlements: string;
  weight: number;
  deviceLimit: number;
  createdAt: string;
  config: string | null;
};
export type ConsoleOrderLite = {
  id: string;
  outTradeNo: string;
  amountCents: number;
  payChannel: string;
  status: string;
  selection: string | null;
  paidAt: string | null;
  createdAt: string;
};
export type ConsoleDeviceLite = {
  id: string;
  deviceId: string;
  name: string | null;
  platform: string | null;
  status: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  createdAt: string;
};
export type ConsoleCustomerDetail = {
  id: string;
  email: string;
  status: string;
  emailVerified: boolean;
  displayName: string | null;
  referralCode: string;
  creditCents: number;
  invitedById: string | null;
  createdAt: string;
  updatedAt: string;
  subscriptions: ConsoleSubscriptionLite[];
  planOrders: ConsoleOrderLite[];
  devices: ConsoleDeviceLite[];
};

// 客户订单（含套餐名 + 客户邮箱）
export type ConsolePlanOrder = {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  amountCents: number;
  payChannel: string;
  outTradeNo: string;
  status: string;
  selection: string | null;
  catalogVersion: number | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  customer: { email: string } | null;
};
export type ConsolePlanOrderList = {
  orders: ConsolePlanOrder[];
  total: number;
  page: number;
  pageSize: number;
};

// 订阅（含套餐名 + 客户邮箱）
export type ConsoleSubscription = {
  id: string;
  customerId: string;
  planId: string | null;
  status: string;
  startsAt: string;
  expiresAt: string | null;
  productEntitlements: string;
  weight: number;
  deviceLimit: number;
  createdAt: string;
  plan: { name: string } | null;
  customer: { email: string } | null;
};
export type ConsoleSubscriptionList = {
  subscriptions: ConsoleSubscription[];
  total: number;
  page: number;
  pageSize: number;
};

// 工单
export type ConsoleTicketListItem = {
  id: string;
  subject: string;
  status: string;
  closedBy?: "CUSTOMER" | "ADMIN" | null;
  urgent: boolean;
  urgentAt: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { email: string } | null;
  _count: { messages: number };
};
export type ConsoleTicketList = {
  tickets: ConsoleTicketListItem[];
  total: number;
  page: number;
  pageSize: number;
};
export type ConsoleTicketMessage = {
  id: string;
  authorType: string;
  body: string;
  createdAt: string;
};
export type ConsoleTicketDetail = {
  id: string;
  customerId: string;
  subject: string;
  status: string;
  closedBy?: "CUSTOMER" | "ADMIN" | null;
  urgent: boolean;
  urgentAt: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { email: string } | null;
  messages: ConsoleTicketMessage[];
};

// 返佣记录
export type ConsoleReferralReward = {
  id: string;
  status: string;
  amountCents: number;
  createdAt: string;
  referrerId: string;
  referrerEmail: string | null;
  inviteeId: string;
  inviteeEmail: string | null;
  planOrderId: string;
  outTradeNo: string | null;
};
export type ConsoleReferralRewardList = {
  rewards: ConsoleReferralReward[];
  total: number;
  page: number;
  pageSize: number;
};

// 计费看板
export type BillingStats = {
  todayNewCustomers: number;
  activeSubscriptions: number;
  todayPaidCents: number;
  todayPaidCount: number;
  refundRate30d: number;
  planDistribution: { planId: string; planName: string; count: number }[];
};

// ── Bulk operation result types (family-groups bulk endpoints) ──

export type CrossInviteResult = {
  allocated: { groupId: string; accountId: string; queued: string[] }[];
  unplaceable: string[];
  alreadyActive: string[];
  reason?: string;
};

export type CrossRemoveResult = {
  queued: string[];
  notFound: string[];
  alreadyRemoved: string[];
  failed: string[];
};

export type BulkGroupInviteResult = {
  queued: string[];
  rejected: string[];
  reason?: string;
};

export type BulkGroupRemoveResult = {
  queued: string[];
  notFound: string[];
  alreadyRemoved: string[];
  failed: string[];
};

export type TransferBatchResult = {
  batchId: string;
  phase: string;
  totalMembers: number;
  memberEmails: string[];
  removeTaskIds: string[];
};

export type TransferStatusResult = {
  id: string;
  phase: string;
  sourceGroupId: string;
  targetGroupId: string;
  sourceGroupName: string;
  targetGroupName: string;
  totalMembers: number;
  removes: { success: number; failed: number; pending: number };
  invites: { sent: number; failed: number; pending: number };
  memberDetails: { email: string; removeStatus: string; inviteStatus?: string }[];
  errorDetail: { email: string; error: string }[];
  createdAt: string;
  updatedAt: string;
};

export type MigrateResult = {
  removedFromGroupId: string;
  removedFromGroupName: string;
  inviteResult: {
    targetGroupId: string;
    targetGroupName: string;
    taskId: string;
  } | null;
  error?: string;
};
