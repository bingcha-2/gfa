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

/**
 * Admin API paths live ONLY under the console surface (/api/console/*) since
 * the legacy bare aliases (/auth, /stats, …) were removed server-side.
 * Callers keep passing resource paths ("auth/me", "stats"); the console/
 * prefix is applied centrally here. Paths already starting with console/ are
 * passed through unchanged.
 */
function withConsolePrefix(path: string): string {
  const rel = path.replace(/^\/+/, "");
  return rel === "console" || rel.startsWith("console/")
    ? rel
    : `console/${rel}`;
}

export async function serverApiRequest<T>(path: string, token: string) {
  const response = await fetch(`${getBackendBaseUrl()}/${withConsolePrefix(path)}`, {
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
  stats: any;
};

export async function getConsoleBootstrapData(token: string) {
  const [user, stats] = await Promise.all([
    serverApiRequest<SessionUser>("auth/me", token),
    serverApiRequest<any>("stats", token) // We will fetch stats instead of everything
  ]);

  return {
    user,
    stats
  } as ConsoleBootstrapData;
}
