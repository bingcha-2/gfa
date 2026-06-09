import * as fs from "fs";
import * as path from "path";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import type { Provider } from "../lease-core/provider";
import { UNIVERSAL_BILLING, parseSnapshotDate } from "../token-server/token-billing";
import { getModelQuotaFraction, getModelQuotaResetAt } from "../token-server/lease-scheduler";
import { ClaudeAccount, RefreshOptions, refreshClaudeAccessToken } from "./auth/claude-token-provider";
import { ClaudeModelCatalog } from "./claude-model-catalog";

/** Clamp a 0..100 remaining-percentage to a finite number in range. */
function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** @deprecated Cards are universal — billing is the shared UNIVERSAL_BILLING
 * (gemini/codex/opus buckets). Kept as an alias for back-compat. */
export const CLAUDE_BILLING = UNIVERSAL_BILLING;

export type ClaudeProviderOptions = {
  accountsFilePath?: string;
  tokenProvider?: (account: ClaudeAccount, opts?: RefreshOptions) => Promise<string>;
};

/**
 * Claude (Anthropic subscription OAuth, Pro/Max). Structurally identical to
 * Codex: account-level single quota window (not per-model), OAuth token refresh,
 * no client-reported credits. The only naming difference from codex is the
 * "claude" quota key and the claudeWindows/claude* display fields.
 */
export class ClaudeProvider implements Provider<ClaudeAccount> {
  // 产品 key(= 卡 bindings 的 key)。产品=anthropic;模型仍是 claude。
  readonly id = "anthropic";
  // 反封核心:绝不从用户本机 IP 直连官方,必须经账号绑定的住宅出口(fail-closed)。
  readonly egressPolicy = "required" as const;
  readonly accountsFilePath: string;
  readonly models = new ClaudeModelCatalog();
  private readonly tokenProvider: (account: ClaudeAccount, opts?: RefreshOptions) => Promise<string>;

  constructor(options: ClaudeProviderOptions = {}) {
    this.accountsFilePath = options.accountsFilePath || path.join(defaultRemoteAccessDataDir(), "anthropic-accounts.json");
    this.tokenProvider = options.tokenProvider || refreshClaudeAccessToken;
  }

  refreshToken(account: ClaudeAccount): Promise<string> {
    // Hand the refresher a disk re-reader so it can adopt a token another writer
    // (the quota-refresh path, or a second process) just rotated — instead of
    // burning a duplicate single-use refresh_token and tripping family revocation.
    return this.tokenProvider(account, { reload: () => this.readAccountFromDisk(account.id) });
  }

  /** Latest persisted copy of one account, straight from disk. Best-effort: any
   * read/parse error yields null so refresh just proceeds without the optimization. */
  private readAccountFromDisk(accountId: number): ClaudeAccount | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.accountsFilePath, "utf8"));
      const accounts = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
      const found = accounts.find((a: any) => Number(a?.id) === accountId);
      return found ? this.normalizeAccount(found) : null;
    } catch {
      return null;
    }
  }

  normalizeAccount(raw: any): ClaudeAccount {
    return {
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      enabled: raw.enabled !== false,
    };
  }

  /** Claude has no projectId requirement; generic core already checks refreshToken. */
  isAccountEligible(): boolean {
    return true;
  }

  /**
   * Claude quota is ACCOUNT-level (one 5h/weekly window per account), not
   * per-model. applyQuotaSnapshot stores the binding fraction under the "claude"
   * key; resolve it for EVERY claude model so scoring is quota-aware even for
   * model names that wouldn't fuzzy-match a narrower key.
   */
  quotaFractionFor(account: ClaudeAccount, _modelKey: string): number | null {
    return getModelQuotaFraction(account, "claude");
  }

  /**
   * Surface the leased account's 5h + weekly remaining windows on every lease
   * response. The client renders the two claude blood bars (5h / 周) straight
   * from this. Omitted entirely until a quota snapshot exists, so the client
   * shows "未知" rather than a fabricated 100%.
   */
  leaseResponseExtras(account: ClaudeAccount): Record<string, unknown> {
    const a = account as Record<string, unknown>;
    const extras: Record<string, unknown> = {};
    // 出口代理(accountProxyUrl)与 egressRequired 由 LeaseService 通用下发,这里不再重复。
    const hourly = typeof a.claudeHourlyPercent === "number" ? a.claudeHourlyPercent : null;
    const weekly = typeof a.claudeWeeklyPercent === "number" ? a.claudeWeeklyPercent : null;
    if (hourly !== null || weekly !== null) {
      extras.claudeWindows = {
        hourlyPercent: hourly,
        weeklyPercent: weekly,
        hourlyResetTime: a.claudeHourlyResetTime ? String(a.claudeHourlyResetTime) : "",
        weeklyResetTime: a.claudeWeeklyResetTime ? String(a.claudeWeeklyResetTime) : "",
      };
    }
    return extras;
  }

  /** Blood bar = the account-level claude binding (min hourly/weekly) fraction.
   * Unknown (no quota snapshot yet) → -1 so the client shows "未知", not a fake 100%. */
  bloodBarFraction(account: ClaudeAccount, _modelKey: string): { fraction: number; resetAt: number } {
    const f = getModelQuotaFraction(account, "claude");
    return { fraction: f === null || f < 0 ? -1 : f, resetAt: getModelQuotaResetAt(account, "claude") };
  }

  /**
   * Surface the raw 5h/weekly remaining percentages and reset times for the
   * console load dashboard.
   */
  statusAccountExtras(account: ClaudeAccount): Record<string, unknown> {
    const a = account as Record<string, unknown>;
    return {
      claudeHourlyPercent: typeof a.claudeHourlyPercent === "number" ? a.claudeHourlyPercent : null,
      claudeWeeklyPercent: typeof a.claudeWeeklyPercent === "number" ? a.claudeWeeklyPercent : null,
      claudeHourlyResetTime: a.claudeHourlyResetTime ? String(a.claudeHourlyResetTime) : "",
      claudeWeeklyResetTime: a.claudeWeeklyResetTime ? String(a.claudeWeeklyResetTime) : "",
    };
  }

  /** 统一水位提取:claude 一个账号级 5h+周窗口,modelKey="claude"。 */
  quotaSnapshotInputs(account: ClaudeAccount) {
    const a = account as Record<string, unknown>;
    if (typeof a.claudeHourlyPercent !== "number" && typeof a.claudeWeeklyPercent !== "number") return [];
    return [
      {
        modelKey: "claude",
        hourlyPercent: typeof a.claudeHourlyPercent === "number" ? a.claudeHourlyPercent : null,
        weeklyPercent: typeof a.claudeWeeklyPercent === "number" ? a.claudeWeeklyPercent : null,
        hourlyResetAt: parseSnapshotDate(a.claudeHourlyResetTime),
        weeklyResetAt: parseSnapshotDate(a.claudeWeeklyResetTime),
      },
    ];
  }

  /**
   * Apply a Claude quota snapshot: hourly(5h) + weekly remaining percentages,
   * parsed by the client from the anthropic-ratelimit-unified-* / retry-after
   * headers. Claude has no per-model quota upstream, so the binding (more
   * restrictive) window maps to a single synthetic "claude" model-quota fraction
   * — fuzzy-matched by every claude model key in scoreAccount/cooldown. Raw
   * percentages are kept for console display. No credits concept.
   */
  applyQuotaSnapshot(account: ClaudeAccount, quota: any): { account: ClaudeAccount } {
    const acc = account as Record<string, unknown>;
    if (quota?.planType && typeof quota.planType === "string") {
      account.planType = quota.planType;
    }
    const cq = quota?.claudeQuota;
    if (cq && typeof cq === "object") {
      const hourly = clampPercent(cq.hourlyPercent);
      const weekly = clampPercent(cq.weeklyPercent);
      const hourlyReset = cq.hourlyResetTime ? String(cq.hourlyResetTime) : "";
      const weeklyReset = cq.weeklyResetTime ? String(cq.weeklyResetTime) : "";

      // Binding window = the more restrictive (lower remaining %) of the two.
      const weeklyBinds = weekly < hourly;
      const bindingPercent = weeklyBinds ? weekly : hourly;
      const bindingReset = weeklyBinds ? weeklyReset : hourlyReset;

      account.modelQuotaFractions = { claude: bindingPercent / 100 };
      // Only overwrite the reset time when the snapshot actually carries one; a
      // window without a reset string must not wipe a still-valid prior reset.
      if (bindingReset) {
        account.modelQuotaResetTimes = { claude: bindingReset };
      } else if (!account.modelQuotaResetTimes) {
        account.modelQuotaResetTimes = {};
      }
      account.modelQuotaRefreshedAt = Date.now();

      acc.claudeHourlyPercent = hourly;
      acc.claudeWeeklyPercent = weekly;
      acc.claudeHourlyResetTime = hourlyReset;
      acc.claudeWeeklyResetTime = weeklyReset;
    }
    return { account };
  }
}
