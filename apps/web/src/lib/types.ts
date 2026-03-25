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
  notes?: string | null;
  lastLoginAt?: string | null;
  lastHealthCheckAt?: string | null;
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
  status: string;
  riskScore: number;
  createdAt: string;
  lastSyncedAt?: string | null;
  account?: {
    id: string;
    name: string;
    loginEmail: string;
  };
  _count?: {
    members: number;
    invites: number;
  };
};

export type OrderSummary = {
  id: string;
  orderNo: string;
  userEmail: string;
  status: string;
  resultMessage?: string | null;
  createdAt: string;
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
};

export type TaskSummary = {
  id: string;
  type: string;
  status: string;
  retryCount: number;
  maxRetryCount: number;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  createdAt: string;
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
  status: string;
  usedAt?: string | null;
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
