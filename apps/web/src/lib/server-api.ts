import "server-only";

import { cookies } from "next/headers";

import {
  AccountSummary,
  FamilyGroupSummary,
  OrderSummary,
  RedeemCodeSummary,
  SessionUser,
  TaskSummary
} from "./types";
import { CONSOLE_AUTH_COOKIE } from "./auth-cookie";

function getBackendBaseUrl() {
  return process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
}

async function parseResponse<T>(response: Response) {
  const raw = await response.text();
  let payload: unknown = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? (payload as { message?: string | string[] }).message
        : raw;

    throw new Error(Array.isArray(message) ? message.join(", ") : message || `Request failed with status ${response.status}`);
  }

  return payload as T;
}

export async function getConsoleTokenFromCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(CONSOLE_AUTH_COOKIE)?.value ?? null;
}

export async function serverApiRequest<T>(path: string, token: string) {
  const response = await fetch(`${getBackendBaseUrl()}/${path.replace(/^\/+/, "")}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    },
    cache: "no-store"
  });

  return parseResponse<T>(response);
}

export type ConsoleBootstrapData = {
  user: SessionUser;
  accounts: AccountSummary[];
  groups: FamilyGroupSummary[];
  orders: OrderSummary[];
  tasks: TaskSummary[];
  redeemCodes: RedeemCodeSummary[];
};

export async function getConsoleBootstrapData(token: string) {
  const [user, accounts, groups, ordersRes, tasksRes, codesRes] = await Promise.all([
    serverApiRequest<SessionUser>("auth/me", token),
    serverApiRequest<AccountSummary[]>("accounts", token),
    serverApiRequest<FamilyGroupSummary[]>("family-groups", token),
    serverApiRequest<{ data: OrderSummary[]; total: number }>("orders?pageSize=100", token),
    serverApiRequest<{ data: TaskSummary[]; total: number }>("tasks?pageSize=100", token),
    serverApiRequest<{ data: RedeemCodeSummary[]; total: number }>("redeem-codes?pageSize=100", token)
  ]);

  return {
    user,
    accounts,
    groups,
    orders: ordersRes.data,
    tasks: tasksRes.data,
    redeemCodes: codesRes.data
  } satisfies ConsoleBootstrapData;
}
