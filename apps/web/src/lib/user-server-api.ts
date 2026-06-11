import "server-only";

import { cookies } from "next/headers";

import { USER_AUTH_COOKIE } from "./user-auth-cookie";
import { getBackendBaseUrl } from "./backend-url";
import type { Customer } from "./user-types";

/** Read the portal user token from the httpOnly cookie (server components only). */
export async function getUserTokenFromCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(USER_AUTH_COOKIE)?.value ?? null;
}

/** Fetch a portal /web/* endpoint with Bearer auth — server component only. */
export async function serverUserApi<T>(path: string): Promise<T> {
  const token = await getUserTokenFromCookie();
  if (!token) {
    throw new Error("UNAUTHORIZED");
  }

  const base = getBackendBaseUrl();
  const url = `${base}/web/${path.replace(/^\/+/, "")}`;

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

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
    if (response.status === 401) throw new Error("UNAUTHORIZED");
    const message =
      payload &&
      typeof payload === "object" &&
      "message" in payload
        ? (payload as { message?: string | string[] }).message
        : raw;
    throw new Error(
      Array.isArray(message)
        ? message.join(", ")
        : message || `Request failed with status ${response.status}`
    );
  }

  return payload as T;
}

/** Convenience: fetch the current customer (/web/me). */
export async function getCustomerFromCookie(): Promise<Customer | null> {
  try {
    return await serverUserApi<Customer>("me");
  } catch {
    return null;
  }
}
