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

// ─── Plan catalog (spec §7.2 — two-line pure selection) ───────────────────────

/** GET /api/plan-catalog response. config is null until a catalog is published. */
export type PlanCatalogResponse = {
  version: number | null;
  config: import("./catalog-pricing").CatalogConfig | null;
};

export type PayChannel = "ALIPAY" | "WXPAY";

export type OrderStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED" | "CANCELLED";

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
  /** 下单时的占位渠道(统一收银台后无实义);展示「支付方式」请优先用 payType。 */
  payChannel: PayChannel;
  /** 真实支付方式,来自网关回调/查询 type:alipay/wxpay/bank…;未支付为 null。 */
  payType?: string | null;
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
  /** Account-internal relay order: lower = used first. */
  priority: number;
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
  used?: number;
  limit: number;
  resetMs?: number;
};

export type SubscriptionQuota = {
  quotaMode: QuotaMode;
  buckets: QuotaBucket[];
  weeklyBuckets?: QuotaBucket[];
  recentWindowTokens: number;
  tokenWindowResetMs: number | null;
  weeklyTokenLimit: number | null;
  weeklyWindowResetMs: number | null;
  /** Tokens used in the current weekly window (sum of weekly buckets, not lifetime). */
  weeklyWindowTokens: number;
  totalTokensUsed: number;
};

export type OverviewSubscription = Subscription & {
  shareSeats?: number;
  shareCapacity?: number;
  seatsLabel?: string;
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

// ─── Usage stats (aggregated — drives the history charts) ─────────────────────

export type UsageStatPoint = {
  /** X 轴标签:hour → "HH:00";day → "MM-DD"。 */
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
};

export type UsageStatModel = {
  modelKey: string;
  totalTokens: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedUSD: number;
};

export type UsageStats = {
  granularity: "hour" | "day";
  points: UsageStatPoint[];
  /** 按 totalTokens 降序。 */
  byModel: UsageStatModel[];
  status: { success: number; failed: number };
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requests: number;
    /** 节省金额(美元)。与客户端同算法:Σ 净输入×family单价 + 输出×family单价。 */
    savedUSD: number;
  };
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
  closedBy?: "CUSTOMER" | "ADMIN" | null;
  urgent: boolean;
  urgentAt: string | null;
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
    closedBy?: "CUSTOMER" | "ADMIN" | null;
    urgent: boolean;
    urgentAt: string | null;
    createdAt: string;
  };
  messages: TicketMessage[];
};

/** PATCH /api/account/tickets/:id/urgent response. */
export type TicketUrgentResult = {
  ticket: {
    id: string;
    urgent: boolean;
    urgentAt: string | null;
  };
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
