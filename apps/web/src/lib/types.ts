export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
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
  status: string;
  riskScore: number;
  createdAt: string;
  lastSyncedAt?: string | null;
  account?: {
    id: string;
    name: string;
    loginEmail: string;
    status?: string;
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
