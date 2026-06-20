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
//
// EGRESS: these probes carry the account's OAuth token, so they MUST leave from
// the same sticky residential IP that serves inference. Refreshing/probing an
// account from the server's datacenter IP while inference comes from a residential
// IP is itself an anti-abuse signal that can get the OAuth session revoked (see
// lease-core/egress.ts). So every call here routes through proxyAwareFetch with
// the account's proxyUrl — never a bare fetch.

import { proxyRequiredFetch } from "../../lease-core/egress";

const CLAUDE_USAGE_URL =
  process.env.BCAI_CLAUDE_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
// Subscription/套餐 lives on the profile endpoint, not usage (Claude Code source:
// src/services/oauth/client.ts fetchProfileInfo → organization.organization_type).
const CLAUDE_PROFILE_URL =
  process.env.BCAI_CLAUDE_PROFILE_URL || "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_USAGE_MAX_ATTEMPTS = 3;
// organization_type → 套餐, mirroring Claude Code's subscriptionType mapping.
const ORG_TYPE_TO_PLAN: Record<string, string> = {
  claude_max: "max",
  claude_pro: "pro",
  claude_enterprise: "enterprise",
  claude_team: "team",
};
// rate_limit_tier → 细档套餐名。绑定线要区分 Max 5x / Max 20x(spec §3.1 levels=
// ["pro","max-5x","max-20x"]),而 organization_type 只给粗粒度 "claude_max"。Claude Code
// 把细档存在 rate_limit_tier(~/.claude/.credentials.json 的 default_claude_max_5x /
// default_claude_max_20x,来自 OAuth profile)。优先用它映射出与 catalog 档名一致的 planType,
// 这样探测出的等级 ↔ account.planType ↔ 绑定匹配天然对齐(根除"档名对不上→绑不上")。
const RATE_LIMIT_TIER_TO_PLAN: Record<string, string> = {
  default_claude_max_20x: "max-20x",
  default_claude_max_5x: "max-5x",
  default_claude_pro: "pro",
  default_claude_ai: "pro",
};

/**
 * Read rate_limit_tier defensively from the profile payload. The exact nesting is
 * not publicly documented — observed in Claude Code's credentials as a flat
 * `rateLimitTier`, but on the wire it may sit at top level, under `account`, or
 * under `organization`. Probe all three (first non-empty wins).
 */
function extractRateLimitTier(data: any): string {
  // Observed (real Max-20x probe, 2026-06): the tier sits at organization.rate_limit_tier,
  // snake_case, e.g. "default_claude_max_20x" — so the confirmed path leads. The field is
  // officially undocumented, so we also probe top-level + account nesting and the camelCase
  // `rateLimitTier` form (Claude Code's ~/.claude/.credentials.json) as cheap drift defense.
  return String(
    data?.organization?.rate_limit_tier ||
      data?.rate_limit_tier ||
      data?.account?.rate_limit_tier ||
      data?.rateLimitTier ||
      data?.account?.rateLimitTier ||
      data?.organization?.rateLimitTier ||
      "",
  ).trim();
}
// Claude Code sends `claude-code/<version>`; the endpoint is lenient but we
// mirror the shape. Overridable if Anthropic ever gates on a specific version.
const CLAUDE_CODE_UA = process.env.BCAI_CLAUDE_USER_AGENT || "claude-code/2.1.162";

export interface ClaudeQuotaWindow {
  /** Remaining 0–100, or -1 = window absent this probe (UNKNOWN → don't persist). */
  hourlyPercent: number;
  /** Remaining 0–100, or -1 = window absent this probe (UNKNOWN → don't persist). */
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
  // Raw GET /api/oauth/profile payload + its HTTP status. Surfaced for diagnosis:
  // whether the profile endpoint actually carries the fine-grained rate_limit_tier
  // (Max 5x/20x) or only the coarse organization_type is UNVERIFIED on the wire,
  // so we log the real body to find out instead of guessing. Best-effort.
  profileRaw?: unknown;
  profileHttpStatus?: number;
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
  const usedPct = util > 0 && util < 1 ? util * 100 : util;
  return clampPercent(100 - usedPct);
}

/**
 * Read the account's 套餐 from GET /api/oauth/profile (no quota cost). Prefer the
 * fine-grained rate_limit_tier (default_claude_max_5x → max-5x / …_20x → max-20x)
 * so the detected planType matches the binding-line catalog levels; fall back to
 * organization.organization_type (coarse max/pro/enterprise/team). planType is ""
 * on any failure; `raw`/`httpStatus` carry the profile response for diagnosis.
 */
async function fetchClaudePlanType(
  accessToken: string,
  proxyUrl?: string,
): Promise<{ planType: string; raw: unknown; httpStatus: number }> {
  try {
    const res = await proxyRequiredFetch(proxyUrl, CLAUDE_PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": CLAUDE_CODE_UA,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { planType: "", raw: body.slice(0, 300), httpStatus: res.status };
    }
    const data: any = await res.json();
    // Fine-grained tier first (distinguishes Max 5x vs 20x); coarse org_type as fallback.
    const tier = extractRateLimitTier(data);
    let planType = "";
    if (tier && RATE_LIMIT_TIER_TO_PLAN[tier]) {
      planType = RATE_LIMIT_TIER_TO_PLAN[tier];
    } else {
      const orgType = String(data?.organization?.organization_type || "").trim();
      planType = ORG_TYPE_TO_PLAN[orgType] || "";
    }
    return { planType, raw: data, httpStatus: res.status };
  } catch {
    return { planType: "", raw: null, httpStatus: 0 };
  }
}

/**
 * Fetch the account's Claude 5h/weekly remaining quota (GET /api/oauth/usage)
 * AND 套餐 (GET /api/oauth/profile) — both side-effect-free, no message sent,
 * no quota consumed. Best-effort: never throws; always returns `raw` + httpStatus.
 */
export async function fetchClaudeQuotaUpstream(
  accessToken: string,
  proxyUrl?: string,
): Promise<ClaudeQuotaSnapshot> {
  if (!accessToken) return { raw: null, httpStatus: 0, error: "missing access token" };
  const [snap, profile] = await Promise.all([
    fetchUsageSnapshot(accessToken, proxyUrl),
    fetchClaudePlanType(accessToken, proxyUrl),
  ]);
  if (profile.planType) snap.planType = profile.planType;
  // Always surface the raw profile payload so the caller can log it: this is the
  // only way to confirm whether /api/oauth/profile carries rate_limit_tier (Max
  // 5x/20x) upstream, which the hand-written specs can't prove.
  snap.profileRaw = profile.raw;
  snap.profileHttpStatus = profile.httpStatus;
  return snap;
}

/** GET /api/oauth/usage → 5h/weekly remaining windows. See fetchClaudeQuotaUpstream. */
async function fetchUsageSnapshot(accessToken: string, proxyUrl?: string): Promise<ClaudeQuotaSnapshot> {
  let last: ClaudeQuotaSnapshot | undefined;
  for (let attempt = 1; attempt <= CLAUDE_USAGE_MAX_ATTEMPTS; attempt++) {
    const snap = await fetchUsageSnapshotOnce(accessToken, proxyUrl);
    last = snap;
    if (!shouldRetryMissingSevenDay(snap)) return snap;
  }
  return last || { raw: null, httpStatus: 0, error: "usage probe did not run" };
}

function shouldRetryMissingSevenDay(snap: ClaudeQuotaSnapshot): boolean {
  const raw = snap.raw;
  const hasSevenDay =
    !!raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "seven_day");
  return (
    snap.httpStatus === 200 &&
    !snap.error &&
    !!snap.claudeQuota &&
    snap.claudeQuota.hourlyPercent >= 0 &&
    snap.claudeQuota.weeklyPercent < 0 &&
    !hasSevenDay
  );
}

async function fetchUsageSnapshotOnce(accessToken: string, proxyUrl?: string): Promise<ClaudeQuotaSnapshot> {
  let resp: Response;
  try {
    resp = await proxyRequiredFetch(proxyUrl, CLAUDE_USAGE_URL, {
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
  // Weekly = ONLY the account-level seven_day window. The model-specific sub-caps
  // (seven_day_opus / seven_day_sonnet / seven_day_oauth_apps) are SEPARATE, much
  // tighter limits — Max's Opus weekly drains fast — and must NEVER masquerade as
  // the overall weekly. The old "fall back to the most restrictive sub-cap when
  // seven_day is missing" logic reported a spurious 周剩余=0 every time the upstream
  // response happened to omit seven_day, which then got persisted and benched a
  // perfectly healthy account (5h fresh, real weekly fine) until the next probe.
  // A missing seven_day is now UNKNOWN (-1), not 0 and not a sub-cap; the persist
  // layer keeps the last good value so one partial probe can't corrupt state.
  const weekly = remainingPercent(data?.seven_day);

  if (hourly < 0 && weekly < 0) {
    // Endpoint answered but carried no usable windows (e.g. non-subscriber).
    return { raw: data, httpStatus: resp.status };
  }
  return {
    raw: data,
    httpStatus: resp.status,
    claudeQuota: {
      // -1 (window absent this probe) flows through as the UNKNOWN sentinel — the
      // caller skips persisting it and keeps the prior value. Never fabricate 100/0.
      hourlyPercent: hourly,
      weeklyPercent: weekly,
      hourlyResetTime: resetToIso(data?.five_hour?.resets_at),
      weeklyResetTime: resetToIso(data?.seven_day?.resets_at),
    },
  };
}
