// Subscription expiry for a mother account, separate from OAuth token expiry.
// Uses the same accounts/check -> subscriptions fallback as the local client.
import { proxyAwareFetch } from "../../lease-core/egress";
import { extractChatGPTAccountId } from "./codex-usage";

export function subscriptionExpiryIso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : NaN
    : typeof value === "string" ? Date.parse(value) : NaN;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseCodexSubscriptionAccount(payload: any, preferredId: string) {
  const source = payload?.accounts;
  const records: Array<[string, any]> = Array.isArray(source)
    ? source.map((node: any) => ["", node])
    : source && typeof source === "object" ? Object.entries(source) : [];
  const idOf = ([key, node]: [string, any]) => {
    const account = node?.account || node;
    return String(account?.account_id || account?.id || key || "");
  };
  // Never silently select a different workspace when the credential identifies one.
  const selected = preferredId
    ? records.find((record) => idOf(record) === preferredId)
    : records.find(([key]) => key === payload?.account_ordering?.[0]) || records[0];
  if (!selected) throw new Error("未找到该母号的订阅信息");
  const node = selected[1];
  return {
    accountId: idOf(selected),
    expiresAt: subscriptionExpiryIso(node?.entitlement?.expires_at)
      || subscriptionExpiryIso((node?.account || node)?.expires_at),
  };
}

export async function fetchCodexSubscription(accessToken: string, proxyUrl?: string) {
  if (!accessToken) throw new Error("缺少 access token");
  const preferredId = extractChatGPTAccountId(accessToken) || "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Referer: "https://chatgpt.com/",
    Origin: "https://chatgpt.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  };
  if (preferredId) headers["ChatGPT-Account-Id"] = preferredId;
  const query = async (url: URL) => {
    const response = await proxyAwareFetch(proxyUrl, url.toString(), {
      method: "GET", headers: {
        ...headers, "x-openai-target-path": url.pathname, "x-openai-target-route": url.pathname,
      }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`订阅查询失败 (HTTP ${response.status})`);
    return response.json();
  };
  const checkUrl = new URL("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27");
  checkUrl.searchParams.set("timezone_offset_min", String(new Date().getTimezoneOffset()));
  const snapshot = parseCodexSubscriptionAccount(await query(checkUrl), preferredId);
  if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) > Date.now()) return snapshot;
  if (!snapshot.accountId) throw new Error("缺少订阅 account_id");
  const subscriptionsUrl = new URL("https://chatgpt.com/backend-api/subscriptions");
  subscriptionsUrl.searchParams.set("account_id", snapshot.accountId);
  const subscription = await query(subscriptionsUrl);
  // A successful response without an expiry means unknown, never lifetime access.
  return {
    accountId: snapshot.accountId,
    expiresAt: subscriptionExpiryIso(subscription?.active_until)
      || subscriptionExpiryIso(subscription?.expires_at) || snapshot.expiresAt,
  };
}
