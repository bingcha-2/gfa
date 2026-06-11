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

export type PortalSession = {
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

export type PortalDevice = {
  id: string;
  deviceId: string;
  name: string | null;
  platform: string;
  status: DeviceStatus;
  lastSeenAt: string | null;
  lastIp: string | null;
};
