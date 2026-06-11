// Server-side Codex upstream quota fetch.
//
// Mirrors the client's codex_quota_sync.go: hit chatgpt.com/backend-api/wham/usage
// with a (freshly refreshed) codex access token to read the account's 5h (primary)
// + weekly (secondary) rate-limit windows, normalized to remaining-percent (0-100,
// higher = healthier) so the console "获取额度" button can pull codex quota on demand
// instead of waiting for a client report.

import { proxyAwareFetch } from "../../lease-core/egress";

const CODEX_USAGE_URL =
  process.env.BCAI_CODEX_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage";

export interface CodexQuotaWindow {
  hourlyPercent: number;
  weeklyPercent: number;
  hourlyResetTime?: string;
  weeklyResetTime?: string;
}

export interface CodexQuotaSnapshot {
  planType?: string;
  codexQuota: CodexQuotaWindow;
}

interface RawUsageWindow {
  used_percent?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
}

interface RawUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: RawUsageWindow | null;
    secondary_window?: RawUsageWindow | null;
  } | null;
}

/** remaining% = 100 - used% (matches cockpit's normalize_remaining_percentage). */
function remainingPercent(used: number | null | undefined): number {
  if (used == null || !Number.isFinite(used)) return 100;
  return Math.max(0, Math.min(100, 100 - used));
}

function resetIso(w: RawUsageWindow | null | undefined, nowSec: number): string {
  if (!w) return "";
  let ts = 0;
  if (typeof w.reset_at === "number" && w.reset_at > 0) ts = w.reset_at;
  else if (typeof w.reset_after_seconds === "number" && w.reset_after_seconds >= 0)
    ts = nowSec + w.reset_after_seconds;
  else return "";
  return new Date(ts * 1000).toISOString();
}

/**
 * Read chatgpt_account_id from the JWT access token's "https://api.openai.com/auth"
 * claim. chatgpt.com validates this header against the token; missing/mismatched → 401.
 */
export function extractChatGPTAccountId(accessToken: string): string {
  const parts = String(accessToken || "").split(".");
  if (parts.length < 2) return "";
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json);
    const auth = claims?.["https://api.openai.com/auth"] || {};
    return String(auth?.chatgpt_account_id || "");
  } catch {
    return "";
  }
}

/**
 * Fetch the account's codex 5h/weekly remaining quota from the upstream usage
 * endpoint. Returns null on any failure (best-effort) — caller decides how to
 * surface it. Throws nothing.
 */
export async function fetchCodexQuotaUpstream(
  accessToken: string,
  proxyUrl?: string,
): Promise<CodexQuotaSnapshot | null> {
  if (!accessToken) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const accId = extractChatGPTAccountId(accessToken);
  if (accId) headers["ChatGPT-Account-Id"] = accId;

  let resp: Response;
  try {
    // Route through the account's exit proxy when set (same egress IP as
    // inference); codex egress is best-effort, so a proxy-less account still
    // probes direct.
    resp = await proxyAwareFetch(proxyUrl, CODEX_USAGE_URL, { method: "GET", headers });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let usage: RawUsageResponse;
  try {
    usage = (await resp.json()) as RawUsageResponse;
  } catch {
    return null;
  }
  const rl = usage?.rate_limit;
  if (!rl) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const window: CodexQuotaWindow = { hourlyPercent: 100, weeklyPercent: 100 };
  if (rl.primary_window) {
    window.hourlyPercent = remainingPercent(rl.primary_window.used_percent);
    window.hourlyResetTime = resetIso(rl.primary_window, nowSec);
  }
  if (rl.secondary_window) {
    window.weeklyPercent = remainingPercent(rl.secondary_window.used_percent);
    window.weeklyResetTime = resetIso(rl.secondary_window, nowSec);
  }
  return { planType: usage.plan_type, codexQuota: window };
}
