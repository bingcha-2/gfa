import * as path from "path";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import type { CreditDelta, Provider } from "../lease-core/provider";
import { UNIVERSAL_BILLING } from "../token-server/token-billing";
import { getModelQuotaFraction, getModelQuotaResetAt } from "../token-server/lease-scheduler";
import { CodexAccount, refreshCodexAccessToken } from "./auth/codex-token-provider";
import { CodexModelCatalog } from "./codex-model-catalog";

/** Clamp a 0..100 remaining-percentage to a finite number in range. */
function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** @deprecated Cards are universal — billing is the shared UNIVERSAL_BILLING
 * (gemini/codex/opus buckets). Kept as an alias for back-compat. */
export const CODEX_BILLING = UNIVERSAL_BILLING;

export type CodexProviderOptions = {
  accountsFilePath?: string;
  tokenProvider?: (account: CodexAccount) => Promise<string>;
};

/**
 * Codex (OpenAI / ChatGPT OAuth). Reuses the full generic LeaseService; the
 * only differences from antigravity are: accounts have no projectId, and there
 * is no client-reported credits/quota snapshot to apply.
 */
export class CodexProvider implements Provider<CodexAccount> {
  readonly id = "codex";
  readonly accountsFilePath: string;
  readonly models = new CodexModelCatalog();
  private readonly tokenProvider: (account: CodexAccount) => Promise<string>;

  constructor(options: CodexProviderOptions = {}) {
    this.accountsFilePath = options.accountsFilePath || path.join(defaultRemoteAccessDataDir(), "codex-accounts.json");
    this.tokenProvider = options.tokenProvider || refreshCodexAccessToken;
  }

  refreshToken(account: CodexAccount): Promise<string> {
    return this.tokenProvider(account);
  }

  normalizeAccount(raw: any): CodexAccount {
    return {
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      enabled: raw.enabled !== false,
    };
  }

  /** Codex has no projectId requirement; generic core already checks refreshToken. */
  isAccountEligible(): boolean {
    return true;
  }

  /**
   * Codex quota is ACCOUNT-level (one 5h/weekly window per account), not
   * per-model. applyQuotaSnapshot stores the binding fraction under the "codex"
   * key; resolve it for EVERY codex model so scoring is quota-aware even for
   * model names that don't contain "codex" (e.g. gpt-5.2, gpt-5.4) — those
   * would otherwise miss the fuzzy match and fall to the neutral tier.
   */
  quotaFractionFor(account: CodexAccount, _modelKey: string): number | null {
    return getModelQuotaFraction(account, "codex");
  }

  /**
   * Surface the leased account's 5h + weekly remaining windows on every lease
   * response. The client renders the two codex blood bars (5h / 周) straight
   * from this — no separate upstream quota fetch needed — so a freshly-activated
   * or idle bound card shows real percentages (sourced from whoever last used
   * the shared account). Omitted entirely until a quota snapshot exists, so the
   * client shows "未知" rather than a fabricated 100%.
   */
  leaseResponseExtras(account: CodexAccount): Record<string, unknown> {
    const a = account as Record<string, unknown>;
    const hourly = typeof a.codexHourlyPercent === "number" ? a.codexHourlyPercent : null;
    const weekly = typeof a.codexWeeklyPercent === "number" ? a.codexWeeklyPercent : null;
    if (hourly === null && weekly === null) return {};
    return {
      codexWindows: {
        hourlyPercent: hourly,
        weeklyPercent: weekly,
        hourlyResetTime: a.codexHourlyResetTime ? String(a.codexHourlyResetTime) : "",
        weeklyResetTime: a.codexWeeklyResetTime ? String(a.codexWeeklyResetTime) : "",
      },
    };
  }

  /** Blood bar = the account-level codex binding (min hourly/weekly) fraction.
   * Unknown (no quota snapshot yet) → -1 so the client shows "未知", not a fake 100%. */
  bloodBarFraction(account: CodexAccount, _modelKey: string): { fraction: number; resetAt: number } {
    const f = getModelQuotaFraction(account, "codex");
    return { fraction: f === null || f < 0 ? -1 : f, resetAt: getModelQuotaResetAt(account, "codex") };
  }

  /**
   * Surface the raw 5h/weekly remaining percentages and reset times for the
   * console load dashboard. applyQuotaSnapshot stores these on the account; the
   * generic status only carries the binding-window fraction, so expose both
   * windows here for per-window progress bars.
   */
  statusAccountExtras(account: CodexAccount): Record<string, unknown> {
    const a = account as Record<string, unknown>;
    return {
      codexHourlyPercent: typeof a.codexHourlyPercent === "number" ? a.codexHourlyPercent : null,
      codexWeeklyPercent: typeof a.codexWeeklyPercent === "number" ? a.codexWeeklyPercent : null,
      codexHourlyResetTime: a.codexHourlyResetTime ? String(a.codexHourlyResetTime) : "",
      codexWeeklyResetTime: a.codexWeeklyResetTime ? String(a.codexWeeklyResetTime) : "",
    };
  }

  /**
   * Apply a client-reported Codex quota snapshot (from chatgpt.com
   * /backend-api/wham/accounts/check): hourly(5h) + weekly remaining percentages.
   * Codex has no per-model quota upstream, so the binding (more restrictive)
   * window maps to a single synthetic "codex" model-quota fraction — fuzzy-matched
   * by every codex model key in scoreAccount/cooldown. Raw percentages are kept
   * for console display. No credits concept → creditDelta is always null.
   */
  applyQuotaSnapshot(account: CodexAccount, quota: any): { account: CodexAccount; creditDelta: CreditDelta | null } {
    const acc = account as Record<string, unknown>;
    if (quota?.planType && typeof quota.planType === "string") {
      account.planType = quota.planType;
    }
    const cq = quota?.codexQuota;
    if (cq && typeof cq === "object") {
      const hourly = clampPercent(cq.hourlyPercent);
      const weekly = clampPercent(cq.weeklyPercent);
      const hourlyReset = cq.hourlyResetTime ? String(cq.hourlyResetTime) : "";
      const weeklyReset = cq.weeklyResetTime ? String(cq.weeklyResetTime) : "";

      // Binding window = the more restrictive (lower remaining %) of the two.
      const weeklyBinds = weekly < hourly;
      const bindingPercent = weeklyBinds ? weekly : hourly;
      const bindingReset = weeklyBinds ? weeklyReset : hourlyReset;

      account.modelQuotaFractions = { codex: bindingPercent / 100 };
      // Only overwrite the reset time when the snapshot actually carries one;
      // a window without a reset string must not wipe a still-valid prior reset
      // (cooldownForExhaustion relies on it to park the account until real reset).
      if (bindingReset) {
        account.modelQuotaResetTimes = { codex: bindingReset };
      } else if (!account.modelQuotaResetTimes) {
        account.modelQuotaResetTimes = {};
      }
      account.modelQuotaRefreshedAt = Date.now();

      acc.codexHourlyPercent = hourly;
      acc.codexWeeklyPercent = weekly;
      acc.codexHourlyResetTime = hourlyReset;
      acc.codexWeeklyResetTime = weeklyReset;
    }
    return { account, creditDelta: null };
  }
}
