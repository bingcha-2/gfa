/**
 * Portal / customer-facing types.
 * These match the backend /web/* contract exactly.
 */

export type Customer = {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  referralCode: string;
  creditCents: number;
  status: string;
  createdAt: string;
};

export type AccountSession = {
  accessToken: string;
  customer: Customer;
};

// ─── Billing (Stage 2a contracts) ─────────────────────────────────────────────

export type Plan = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  durationDays: number;
  products: string[];
  deviceLimit: number;
  weight: number;
  sortOrder: number;
};

export type PayChannel = "ALIPAY" | "WXPAY";

export type OrderStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED";

/** POST /web/billing/orders response. */
export type BillingOrderCreated = {
  outTradeNo: string;
  amountCents: number;
  /** 套餐基准价（分）。amountCents = baseCents + feeCents。 */
  baseCents: number;
  /** 支付通道手续费（分），由用户承担。0 表示未加价。 */
  feeCents: number;
  expiresAt: string;
  payUrl: string;
  /** data:image/png;base64 — render directly in <img>, no QR library. */
  qrDataUri: string;
};

/** GET /web/billing/orders/:outTradeNo response. */
export type BillingOrderState = {
  outTradeNo: string;
  status: OrderStatus;
  paidAt?: string;
  subscriptionId?: string;
};

/** GET /web/billing/orders list item. */
export type BillingOrderRecord = {
  outTradeNo: string;
  planName: string;
  amountCents: number;
  payChannel: PayChannel;
  status: OrderStatus;
  createdAt: string;
  paidAt?: string | null;
};

export type Subscription = {
  id: string;
  /** null for card-migrated subscriptions — display 迁移卡密订阅. */
  planName: string | null;
  status: string;
  products: string[];
  expiresAt: string | null;
  deviceLimit: number;
  weight: number;
  migratedFromCard: boolean;
};

/** POST /web/bind-card success response. */
export type BindCardResult = {
  ok: true;
  alreadyBound?: true;
  subscription: {
    id: string;
    expiresAt: string | null;
    products: string[];
    deviceLimit: number;
    planName: null;
  };
};

// ─── Devices (Stage 2a contracts) ─────────────────────────────────────────────

export type DeviceStatus = "ACTIVE" | "REVOKED";

export type AccountDevice = {
  id: string;
  deviceId: string;
  name: string | null;
  platform: string;
  status: DeviceStatus;
  lastSeenAt: string | null;
  lastIp: string | null;
};

// ─── Overview / quota (Stage 2b — M9 contract A) ──────────────────────────────

export type QuotaMode = "static" | "dynamic" | "unlimited";

export type QuotaBucket = {
  bucket: string;
  used: number;
  limit: number;
};

export type SubscriptionQuota = {
  quotaMode: QuotaMode;
  buckets: QuotaBucket[];
  recentWindowTokens: number;
  tokenWindowResetMs: number | null;
  weeklyTokenLimit: number | null;
  weeklyWindowResetMs: number | null;
  /** Tokens used in the current weekly window (sum of weekly buckets, not lifetime). */
  weeklyWindowTokens: number;
  totalTokensUsed: number;
};

export type OverviewSubscription = Subscription & {
  quota: SubscriptionQuota;
};

export type AccountOverview = {
  customer: Customer;
  subscriptions: OverviewSubscription[];
  devices: { count: number; limit: number };
  unreadNotifications: number;
};

// ─── Usage (contract B) ───────────────────────────────────────────────────────

export type UsageDays = 1 | 7 | 30;

export type UsageRecord = {
  id: string;
  timestamp: string;
  modelKey: string;
  bucket: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type UsagePage = {
  records: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
};

// ─── Notifications (contracts C/D) ────────────────────────────────────────────

export type NotificationType =
  | "SYSTEM"
  | "BILLING"
  | "TICKET"
  | "REFERRAL"
  | "MIGRATION";

export type AccountNotification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export type NotificationsPage = {
  notifications: AccountNotification[];
  total: number;
  unread: number;
};

// ─── Tickets (contracts E-H) ──────────────────────────────────────────────────

export type TicketStatus = "OPEN" | "ANSWERED" | "CLOSED";

export type TicketSummary = {
  id: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
};

export type TicketMessage = {
  id: string;
  authorType: "CUSTOMER" | "ADMIN";
  body: string;
  createdAt: string;
};

export type TicketDetail = {
  ticket: {
    id: string;
    subject: string;
    status: TicketStatus;
    createdAt: string;
  };
  messages: TicketMessage[];
};

// ─── Referral (contract I) ────────────────────────────────────────────────────

export type ReferralInvitee = {
  email: string;
  registeredAt: string;
  rewarded: boolean;
};

export type ReferralInfo = {
  referralCode: string;
  referralLink: string;
  invitees: ReferralInvitee[];
  rewards: { totalCents: number; grantedCount: number };
  creditCents: number;
};
