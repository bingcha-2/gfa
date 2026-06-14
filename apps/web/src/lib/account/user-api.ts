"use client";

/**
 * Client-side portal API wrappers.
 *
 * All API traffic is routed through same-origin Next.js route handlers:
 *   - auth actions  → /api/account-session/*
 *   - data          → /api/account/* (generic authenticated proxy)
 *
 * NEVER call the backend directly from client code.
 */

import type {
  BillingOrderCreated,
  BillingOrderRecord,
  BillingOrderState,
  BindCardResult,
  NotificationsPage,
  PayChannel,
  PlanCatalogResponse,
  AccountDevice,
  AccountOverview,
  ReferralInfo,
  Subscription,
  TicketDetail,
  TicketMessage,
  TicketSummary,
  TicketUrgentResult,
  UsageDays,
  UsagePage,
  UsageStats,
} from "./user-types";
import type { Selection } from "./catalog-pricing";

type RequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

type UserApiOptions = {
  method?: RequestMethod;
  body?: unknown;
  search?: Record<string, string | number | boolean | undefined>;
};

function buildUrl(
  path: string,
  search?: UserApiOptions["search"]
) {
  const targetPath = `/api/account/${path.replace(/^\/+/, "")}`;
  if (!search) return targetPath;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v !== undefined && v !== null && v !== "") {
      params.set(k, String(v));
    }
  }
  const query = params.toString();
  return query ? `${targetPath}?${query}` : targetPath;
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const m = (payload as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join(", ");
    if (typeof m === "string") return m;
  }
  return fallback;
}

/**
 * Error thrown by userApi on non-2xx responses.
 * `code` carries the backend's machine-readable error field
 * (e.g. CARD_NOT_FOUND, CARD_ALREADY_BOUND) for per-code UI messages.
 */
export class UserApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "UserApiError";
    this.status = status;
    this.code = code;
  }
}

function extractCode(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const e = (payload as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return null;
}

/** Generic portal data call through /api/account/[...path]. */
export async function userApi<T>(
  path: string,
  options: UserApiOptions = {}
): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const resp = await fetch(buildUrl(path, options.search), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  const rawText = await resp.text();
  const payload = rawText ? safeJson(rawText) : null;

  if (!resp.ok) {
    throw new UserApiError(
      extractMessage(payload, rawText || `Request failed with status ${resp.status}`),
      resp.status,
      extractCode(payload)
    );
  }

  return payload as T;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function accountSessionPost<T>(
  action: string,
  body: unknown
): Promise<T> {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });

  const resp = await fetch(`/api/account-session/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const rawText = await resp.text();
  const payload = rawText ? safeJson(rawText) : null;

  if (!resp.ok) {
    throw new Error(
      extractMessage(payload, rawText || `Request failed with status ${resp.status}`)
    );
  }

  return payload as T;
}

export async function loginUser(email: string, password: string) {
  return accountSessionPost<{ customer: import("./user-types").Customer }>(
    "login",
    { email, password }
  );
}

export async function registerUser(
  email: string,
  password: string,
  displayName?: string,
  referralCode?: string
) {
  return accountSessionPost<{ customer: import("./user-types").Customer }>(
    "register",
    { email, password, displayName, referralCode }
  );
}

export async function logoutUser() {
  return accountSessionPost<{ ok: boolean }>("logout", {});
}

export async function forgotPassword(email: string) {
  return accountSessionPost<{ ok: boolean }>("forgot", { email });
}

export async function resetPassword(token: string, password: string) {
  return accountSessionPost<{ ok: boolean }>("reset", { token, password });
}

// ─── Billing helpers (Stage 2a) ───────────────────────────────────────────────

/**
 * Public plan catalog (spec §7.2) — drives the two-line purchase page.
 * Goes through /api/plan-catalog (public route handler), NOT the /api/account
 * proxy: the catalog is unauthenticated and lives at the backend root.
 */
export async function getPlanCatalog(): Promise<PlanCatalogResponse> {
  const resp = await fetch("/api/plan-catalog", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });

  const rawText = await resp.text();
  const payload = rawText ? safeJson(rawText) : null;

  if (!resp.ok) {
    throw new UserApiError(
      extractMessage(payload, rawText || `Request failed with status ${resp.status}`),
      resp.status,
      extractCode(payload)
    );
  }

  return payload as PlanCatalogResponse;
}

/**
 * Catalog-driven order (spec §8). Submits a selection (号池/绑定 line + knobs);
 * the backend recomputes the price authoritatively and returns the same
 * BillingOrderCreated shape (payUrl + qrDataUri) as the legacy plan order.
 */
// 统一收银台:channel 可选(用户在网关侧自选 alipay/wxpay/bank)。不传则后端占位。
export async function createCatalogOrder(selection: Selection, channel?: PayChannel) {
  return userApi<BillingOrderCreated>("billing/catalog-orders", {
    method: "POST",
    body: channel ? { selection, channel } : { selection },
  });
}

export async function getBillingOrderState(outTradeNo: string) {
  return userApi<BillingOrderState>(`billing/orders/${outTradeNo}`);
}

/** 取消一笔未支付订单。幂等:已支付/已终态的单原样返回当前状态。 */
export async function cancelBillingOrder(outTradeNo: string) {
  return userApi<BillingOrderState>(`billing/orders/${outTradeNo}/cancel`, {
    method: "POST",
  });
}

export async function refundBillingOrder(outTradeNo: string) {
  return userApi<{ ok: boolean; alreadyRefunded: boolean; refundedCents: number }>(
    `billing/orders/${outTradeNo}/refund`,
    { method: "POST" },
  );
}

export async function listBillingOrders(page: number, pageSize: number) {
  return userApi<{ orders: BillingOrderRecord[]; total: number }>(
    "billing/orders",
    { search: { page, pageSize } }
  );
}

export async function getSubscriptions() {
  return userApi<{ subscriptions: Subscription[] }>("subscriptions");
}

/** Set a subscription's relay priority (lower = used first). Returns the refreshed overview. */
export async function setSubscriptionPriority(subscriptionId: string, priority: number) {
  return userApi<AccountOverview>("subscriptions/priority", {
    method: "POST",
    body: { subscriptionId, priority },
  });
}

export async function bindCard(cardKey: string) {
  return userApi<BindCardResult>("bind-card", {
    method: "POST",
    body: { cardKey },
  });
}

// ─── Device helpers (Stage 2a) ────────────────────────────────────────────────

export async function getDevices() {
  return userApi<{ devices: AccountDevice[]; deviceLimit: number }>("devices");
}

export async function renameDevice(id: string, name: string) {
  return userApi<{ ok: true; device: AccountDevice }>(`devices/${id}`, {
    method: "PATCH",
    body: { name },
  });
}

export async function revokeDevice(id: string) {
  return userApi<{ ok: true }>(`devices/${id}/revoke`, {
    method: "POST",
    body: {},
  });
}

// ─── Overview / usage / notifications / tickets / referral (Stage 2b) ─────────

export async function getPortalOverview() {
  return userApi<AccountOverview>("portal/overview");
}

export async function getUsage(page: number, pageSize: number, days: UsageDays) {
  return userApi<UsagePage>("usage", { search: { page, pageSize, days } });
}

/** 历史记录页统计图聚合数据(按 1/7/30 天窗口)。 */
export async function getUsageStats(days: UsageDays) {
  return userApi<UsageStats>("usage/stats", { search: { days } });
}

export async function getNotifications(page: number, pageSize: number) {
  return userApi<NotificationsPage>("notifications", {
    search: { page, pageSize },
  });
}

export async function markNotificationRead(id: string) {
  return userApi<{ ok: true }>(`notifications/${id}/read`, {
    method: "POST",
    body: {},
  });
}

export async function markAllNotificationsRead() {
  return userApi<{ ok: true }>("notifications/read-all", {
    method: "POST",
    body: {},
  });
}

export async function getTickets() {
  return userApi<{ tickets: TicketSummary[] }>("tickets");
}

export async function createTicket(subject: string, body: string) {
  return userApi<{ ticket: TicketSummary }>("tickets", {
    method: "POST",
    body: { subject, body },
  });
}

export async function getTicket(id: string) {
  return userApi<TicketDetail>(`tickets/${id}`);
}

export async function replyTicket(id: string, body: string) {
  return userApi<{ message: TicketMessage }>(`tickets/${id}/messages`, {
    method: "POST",
    body: { body },
  });
}

/** 加急 / 取消加急 自己的工单(立即生效;CLOSED 工单返回 409 TICKET_CLOSED)。 */
export async function setTicketUrgent(id: string, urgent: boolean) {
  return userApi<TicketUrgentResult>(`tickets/${id}/urgent`, {
    method: "PATCH",
    body: { urgent },
  });
}

export async function getReferral() {
  return userApi<ReferralInfo>("referral");
}

// ─── Email verification (contract J — unauthenticated, via web-session) ───────

export type VerifyEmailResult =
  | { ok: true }
  | { ok: false; code: string };

/**
 * Verify an email token. Goes through /api/account-session/verify-email because
 * the user may NOT be logged in when clicking the link from their inbox
 * (the /api/account proxy would reject without a cookie).
 * Returns a discriminated result instead of throwing — the page renders states.
 */
export async function verifyEmailToken(token: string): Promise<VerifyEmailResult> {
  const resp = await fetch("/api/account-session/verify-email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });

  if (resp.ok) return { ok: true };

  const rawText = await resp.text();
  const payload = rawText ? safeJson(rawText) : null;
  const code =
    payload && typeof payload === "object" && "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
      ? ((payload as { error: string }).error)
      : "UNKNOWN";
  return { ok: false, code };
}
