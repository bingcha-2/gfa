"use client";

/**
 * Client-side portal API wrappers.
 *
 * All API traffic is routed through same-origin Next.js route handlers:
 *   - auth actions  → /api/web-session/*
 *   - data          → /api/web/* (generic authenticated proxy)
 *
 * NEVER call the backend directly from client code.
 */

import type {
  BillingOrderCreated,
  BillingOrderRecord,
  BillingOrderState,
  BindCardResult,
  PayChannel,
  Plan,
  PortalDevice,
  Subscription,
} from "./user-types";

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
  const targetPath = `/api/web/${path.replace(/^\/+/, "")}`;
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

/** Generic portal data call through /api/web/[...path]. */
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

async function webSessionPost<T>(
  action: string,
  body: unknown
): Promise<T> {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });

  const resp = await fetch(`/api/web-session/${action}`, {
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
  return webSessionPost<{ customer: import("./user-types").Customer }>(
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
  return webSessionPost<{ customer: import("./user-types").Customer }>(
    "register",
    { email, password, displayName, referralCode }
  );
}

export async function logoutUser() {
  return webSessionPost<{ ok: boolean }>("logout", {});
}

export async function forgotPassword(email: string) {
  return webSessionPost<{ ok: boolean }>("forgot", { email });
}

export async function resetPassword(token: string, password: string) {
  return webSessionPost<{ ok: boolean }>("reset", { token, password });
}

// ─── Billing helpers (Stage 2a) ───────────────────────────────────────────────

export async function getPlans() {
  return userApi<{ plans: Plan[] }>("plans");
}

export async function createBillingOrder(planId: string, channel: PayChannel) {
  return userApi<BillingOrderCreated>("billing/orders", {
    method: "POST",
    body: { planId, channel },
  });
}

export async function getBillingOrderState(outTradeNo: string) {
  return userApi<BillingOrderState>(`billing/orders/${outTradeNo}`);
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

export async function bindCard(cardKey: string) {
  return userApi<BindCardResult>("bind-card", {
    method: "POST",
    body: { cardKey },
  });
}

// ─── Device helpers (Stage 2a) ────────────────────────────────────────────────

export async function getDevices() {
  return userApi<{ devices: PortalDevice[]; deviceLimit: number }>("devices");
}

export async function renameDevice(id: string, name: string) {
  return userApi<{ ok: true; device: PortalDevice }>(`devices/${id}`, {
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
