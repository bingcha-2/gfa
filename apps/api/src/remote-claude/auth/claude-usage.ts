// Server-side Claude (Anthropic) upstream quota probe.
//
// Unlike codex (which has a JSON usage endpoint), Claude exposes its 5h/weekly
// subscription windows ONLY via `anthropic-ratelimit-unified-*` response headers
// on real API calls. So the console "刷新额度" button fires a minimal probe with
// a freshly-refreshed OAuth access token and reads those headers.
//
// Two hard constraints (both handled here):
//   1. OAuth subscription tokens are authorized ONLY for Claude Code — the probe
//      must mimic Claude Code (anthropic-beta: oauth-2025-04-20 + the Claude Code
//      system prompt) or Anthropic rejects it (401/400).
//   2. The exact unified header field names are not pinned in this repo. We parse
//      defensively across the known candidate names AND return EVERY captured
//      `anthropic-ratelimit-*` header (rawHeaders) so the real format can be
//      confirmed from one live click and the parser finalized if needed.

// The unified 5h/weekly rate-limit headers only appear on a REAL generation
// response — count_tokens returns none. So the probe sends a minimal
// /v1/messages with max_tokens:1 (≈1 output token, cost negligible).
const CLAUDE_MESSAGES_URL =
  process.env.BCAI_CLAUDE_PROBE_URL || "https://api.anthropic.com/v1/messages";
const CLAUDE_MODELS_URL =
  process.env.BCAI_CLAUDE_MODELS_URL || "https://api.anthropic.com/v1/models";
// Fallback model when discovery fails. Model availability varies per subscription
// (a hardcoded id can 404), so we discover a valid one from the account first.
const CLAUDE_PROBE_MODEL_FALLBACK =
  process.env.BCAI_CLAUDE_PROBE_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
// Anthropic only accepts OAuth subscription tokens when the request looks like
// Claude Code — the first system block must be exactly this string.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface ClaudeQuotaWindow {
  hourlyPercent: number;
  weeklyPercent: number;
  hourlyResetTime?: string;
  weeklyResetTime?: string;
}

export interface ClaudeQuotaSnapshot {
  planType?: string;
  // Present only when the unified 5h/weekly headers could be parsed.
  claudeQuota?: ClaudeQuotaWindow;
  // Every captured `anthropic-ratelimit-*` header (lowercased name → value),
  // always returned for diagnosis/finalizing the parser.
  rawHeaders: Record<string, string>;
  httpStatus: number;
  // Best-effort error text when the probe itself failed (network / auth).
  error?: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return -1;
  return Math.max(0, Math.min(100, value));
}

/** Convert a reset header (unix seconds, unix ms, or HTTP/ISO date) to ISO. */
function resetToIso(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) {
    let n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return "";
    // Heuristic: < 1e12 → seconds; else milliseconds.
    if (n < 1e12) n *= 1000;
    return new Date(n).toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : "";
}

/**
 * Derive a remaining-percent for one window from a header set, trying several
 * shapes Anthropic has used: a direct percentage, or remaining/limit counts.
 * Returns -1 when nothing usable is found.
 */
function windowPercent(h: Record<string, string>, keys: string[]): number {
  for (const k of keys) {
    const pctKey = `anthropic-ratelimit-unified-${k}-remaining-percent`;
    if (h[pctKey] != null) return clampPercent(Number(h[pctKey]));
  }
  for (const k of keys) {
    const remaining = h[`anthropic-ratelimit-unified-${k}-remaining`];
    const limit = h[`anthropic-ratelimit-unified-${k}-limit`];
    if (remaining != null && limit != null) {
      const r = Number(remaining);
      const l = Number(limit);
      if (Number.isFinite(r) && Number.isFinite(l) && l > 0) return clampPercent((r / l) * 100);
    }
  }
  return -1;
}

function windowReset(h: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const v = h[`anthropic-ratelimit-unified-${k}-reset`];
    const iso = resetToIso(v);
    if (iso) return iso;
  }
  return "";
}

/**
 * Pick a model the account can actually use. A hardcoded id can 404 (model set
 * varies per subscription), so we read /v1/models and prefer the cheapest
 * (a haiku). Best-effort: returns "" on any failure so the caller falls back.
 */
async function discoverProbeModel(accessToken: string): Promise<string> {
  try {
    const res = await fetch(CLAUDE_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        accept: "application/json",
      },
    });
    if (!res.ok) return "";
    const body: any = await res.json();
    const arr = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const ids: string[] = arr
      .map((m: any) => String(m?.id || m?.slug || m?.model || m || "").trim())
      .filter(Boolean);
    if (!ids.length) return "";
    return ids.find((id) => id.toLowerCase().includes("haiku")) || ids[0];
  } catch {
    return "";
  }
}

/**
 * Probe Anthropic with the account's access token and read the subscription
 * 5h/weekly windows from the response's `anthropic-ratelimit-unified-*` headers.
 * Best-effort: never throws. Always returns rawHeaders so the caller can log and
 * (if needed) finalize the parser against the real header names.
 */
export async function fetchClaudeQuotaUpstream(
  accessToken: string,
): Promise<ClaudeQuotaSnapshot> {
  const empty = (extra: Partial<ClaudeQuotaSnapshot>): ClaudeQuotaSnapshot => ({
    rawHeaders: {},
    httpStatus: 0,
    ...extra,
  });
  if (!accessToken) return empty({ error: "missing access token" });

  const model = (await discoverProbeModel(accessToken)) || CLAUDE_PROBE_MODEL_FALLBACK;

  let resp: Response;
  try {
    resp = await fetch(CLAUDE_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "user-agent": "claude-cli/1.0.0 (external, cli)",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  } catch (err: any) {
    return empty({ error: String(err?.message || err) });
  }

  // Capture every anthropic-ratelimit-* header (lowercased) for diagnosis.
  const rawHeaders: Record<string, string> = {};
  resp.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("anthropic-ratelimit")) rawHeaders[lower] = value;
  });

  if (!resp.ok) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 300);
    } catch {
      // ignore
    }
    return { rawHeaders, httpStatus: resp.status, error: `HTTP ${resp.status} ${body}`.trim() };
  }

  // 5h window: try "5h" then "five_hour"; weekly: "7d" / "week" / "weekly".
  const hourly = windowPercent(rawHeaders, ["5h", "five_hour", "fivehour"]);
  const weekly = windowPercent(rawHeaders, ["7d", "week", "weekly", "seven_day"]);
  const hourlyReset = windowReset(rawHeaders, ["5h", "five_hour", "fivehour"]);
  const weeklyReset = windowReset(rawHeaders, ["7d", "week", "weekly", "seven_day"]);

  if (hourly < 0 && weekly < 0) {
    // Probe succeeded but the unified windows weren't found under any known name.
    return { rawHeaders, httpStatus: resp.status };
  }
  return {
    rawHeaders,
    httpStatus: resp.status,
    claudeQuota: {
      hourlyPercent: hourly < 0 ? 100 : hourly,
      weeklyPercent: weekly < 0 ? 100 : weekly,
      hourlyResetTime: hourlyReset,
      weeklyResetTime: weeklyReset,
    },
  };
}
