// Server-side Claude (Anthropic) upstream quota fetch.
//
// Claude Code reads subscription usage from a dedicated, side-effect-free
// endpoint: GET https://api.anthropic.com/api/oauth/usage (see Claude Code
// source: src/services/api/usage.ts). It returns per-window utilization — NO
// message is sent and NO quota is consumed. We mirror that here so the console
// "刷新额度" button can pull the account's 5h/weekly windows on demand.
//
// Response shape (Claude Code's `Utilization`):
//   { five_hour?: { utilization, resets_at }, seven_day?: {...},
//     seven_day_opus?, seven_day_sonnet?, seven_day_oauth_apps?, extra_usage? }
// `utilization` is a USED fraction (Claude Code's StatusLine multiplies by 100),
// `resets_at` is an ISO 8601 timestamp. We store REMAINING percent (higher =
// healthier) to match codex/the blood bar: remaining = (1 - utilization) * 100.

const CLAUDE_USAGE_URL =
  process.env.BCAI_CLAUDE_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
// Subscription/套餐 lives on the profile endpoint, not usage (Claude Code source:
// src/services/oauth/client.ts fetchProfileInfo → organization.organization_type).
const CLAUDE_PROFILE_URL =
  process.env.BCAI_CLAUDE_PROFILE_URL || "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
// organization_type → 套餐, mirroring Claude Code's subscriptionType mapping.
const ORG_TYPE_TO_PLAN: Record<string, string> = {
  claude_max: "max",
  claude_pro: "pro",
  claude_enterprise: "enterprise",
  claude_team: "team",
};
// Claude Code sends `claude-code/<version>`; the endpoint is lenient but we
// mirror the shape. Overridable if Anthropic ever gates on a specific version.
const CLAUDE_CODE_UA = process.env.BCAI_CLAUDE_USER_AGENT || "claude-code/2.1.162";

export interface ClaudeQuotaWindow {
  hourlyPercent: number;
  weeklyPercent: number;
  hourlyResetTime?: string;
  weeklyResetTime?: string;
}

export interface ClaudeQuotaSnapshot {
  planType?: string;
  // Present only when at least one window could be read.
  claudeQuota?: ClaudeQuotaWindow;
  // Parsed usage payload, always returned for diagnosis/logging.
  raw: unknown;
  httpStatus: number;
  // Best-effort error text when the fetch itself failed (network / auth).
  error?: string;
}

interface RawRateLimit {
  utilization?: number | null;
  resets_at?: string | number | null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return -1;
  return Math.max(0, Math.min(100, value));
}

/** Convert a reset value (ISO string, or unix seconds/ms) to an ISO string. */
function resetToIso(raw: string | number | null | undefined): string {
  if (raw == null) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "";
    return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString();
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : "";
}

/** REMAINING percent from a window's USED `utilization` (0–1 fraction, or 0–100). */
function remainingPercent(w: RawRateLimit | null | undefined): number {
  if (!w || w.utilization == null || !Number.isFinite(Number(w.utilization))) return -1;
  const util = Number(w.utilization);
  const usedPct = util <= 1 ? util * 100 : util;
  return clampPercent(100 - usedPct);
}

/**
 * Read the account's 套餐 from GET /api/oauth/profile (no quota cost). Maps
 * organization.organization_type → max/pro/enterprise/team. "" on any failure.
 */
async function fetchClaudePlanType(accessToken: string): Promise<string> {
  try {
    const res = await fetch(CLAUDE_PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": CLAUDE_CODE_UA,
      },
    });
    if (!res.ok) return "";
    const data: any = await res.json();
    const orgType = String(data?.organization?.organization_type || "").trim();
    return ORG_TYPE_TO_PLAN[orgType] || "";
  } catch {
    return "";
  }
}

/**
 * Fetch the account's Claude 5h/weekly remaining quota (GET /api/oauth/usage)
 * AND 套餐 (GET /api/oauth/profile) — both side-effect-free, no message sent,
 * no quota consumed. Best-effort: never throws; always returns `raw` + httpStatus.
 */
export async function fetchClaudeQuotaUpstream(
  accessToken: string,
): Promise<ClaudeQuotaSnapshot> {
  if (!accessToken) return { raw: null, httpStatus: 0, error: "missing access token" };
  const [snap, planType] = await Promise.all([
    fetchUsageSnapshot(accessToken),
    fetchClaudePlanType(accessToken),
  ]);
  if (planType) snap.planType = planType;
  return snap;
}

/** GET /api/oauth/usage → 5h/weekly remaining windows. See fetchClaudeQuotaUpstream. */
async function fetchUsageSnapshot(accessToken: string): Promise<ClaudeQuotaSnapshot> {
  let resp: Response;
  try {
    resp = await fetch(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "user-agent": CLAUDE_CODE_UA,
      },
    });
  } catch (err: any) {
    return { raw: null, httpStatus: 0, error: String(err?.message || err) };
  }

  if (!resp.ok) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 300);
    } catch {
      // ignore
    }
    return { raw: body, httpStatus: resp.status, error: `HTTP ${resp.status} ${body}`.trim() };
  }

  let data: any;
  try {
    data = await resp.json();
  } catch (err: any) {
    return { raw: null, httpStatus: resp.status, error: `bad JSON: ${String(err?.message || err)}` };
  }

  const hourly = remainingPercent(data?.five_hour);
  // Weekly: prefer the account-level seven_day window; otherwise the most
  // restrictive (lowest remaining) of the model-specific weekly variants.
  let weekly = remainingPercent(data?.seven_day);
  let weeklyWindow: RawRateLimit | null | undefined = data?.seven_day;
  if (weekly < 0) {
    for (const key of ["seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"]) {
      const p = remainingPercent(data?.[key]);
      if (p >= 0 && (weekly < 0 || p < weekly)) {
        weekly = p;
        weeklyWindow = data?.[key];
      }
    }
  }

  if (hourly < 0 && weekly < 0) {
    // Endpoint answered but carried no usable windows (e.g. non-subscriber).
    return { raw: data, httpStatus: resp.status };
  }
  return {
    raw: data,
    httpStatus: resp.status,
    claudeQuota: {
      hourlyPercent: hourly < 0 ? 100 : hourly,
      weeklyPercent: weekly < 0 ? 100 : weekly,
      hourlyResetTime: resetToIso(data?.five_hour?.resets_at),
      weeklyResetTime: resetToIso(weeklyWindow?.resets_at),
    },
  };
}
