import * as path from "path";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import type { Provider } from "../lease-core/provider";
import { UNIVERSAL_BILLING, parseSnapshotDate } from "../token-server/token-billing";
import { getModelQuotaFraction } from "../token-server/lease-scheduler";
import { CodexAccount, refreshCodexAccessToken } from "./auth/codex-token-provider";
import { codexBindingWindow } from "./auth/codex-usage";
import { CodexModelCatalog } from "./codex-model-catalog";
import { codexPlanSupportsFast } from "./codex-service-tier";

/** Clamp a 0..100 remaining-percentage to a finite number in range. */
function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function storedPresence(a: Record<string, unknown>, window: "Hourly" | "Weekly"): boolean | undefined {
  const explicit = a[`codex${window}Present`];
  if (typeof explicit === "boolean") return explicit;
  const percent = a[`codex${window}Percent`];
  return typeof percent === "number" && percent >= 0 ? true : undefined;
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
  // 绑定代理则用,没绑定就本地直连(fail-open);代理传输失败先降级本地再切号。
  readonly egressPolicy = "optional" as const;
  // codex 瞬时限速(too_many_requests)同 anthropic:账号健康、几秒恢复 → 零冷却。
  readonly rateLimitZeroCooldown = true;
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
    const extras: Record<string, unknown> = {};
    // 快速档「能力闸」:被租号 plan 支持快速就下发 true(是否真开由用户 app 端开关决定)。
    // 见 codex-service-tier.ts。
    if (codexPlanSupportsFast(String(a.planType || ""))) {
      extras.codexFastAllowed = true;
    }
    const hourly = typeof a.codexHourlyPercent === "number" ? a.codexHourlyPercent : null;
    const weekly = typeof a.codexWeeklyPercent === "number" ? a.codexWeeklyPercent : null;
    const hourlyPresent = storedPresence(a, "Hourly");
    const weeklyPresent = storedPresence(a, "Weekly");
    if (hourly !== null || weekly !== null || hourlyPresent !== undefined || weeklyPresent !== undefined) {
      extras.codexWindows = {
        hourlyPercent: hourly ?? -1,
        weeklyPercent: weekly ?? -1,
        hourlyResetTime: a.codexHourlyResetTime ? String(a.codexHourlyResetTime) : "",
        weeklyResetTime: a.codexWeeklyResetTime ? String(a.codexWeeklyResetTime) : "",
        ...(hourlyPresent !== undefined ? { hourlyPresent } : {}),
        ...(weeklyPresent !== undefined ? { weeklyPresent } : {}),
      };
    }
    return extras;
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

  /** 统一水位提取:codex 一个账号级 5h+周窗口,modelKey="codex"。 */
  quotaSnapshotInputs(account: CodexAccount) {
    const a = account as Record<string, unknown>;
    const hourlyPresent = storedPresence(a, "Hourly");
    const weeklyPresent = storedPresence(a, "Weekly");
    if (typeof a.codexHourlyPercent !== "number" && typeof a.codexWeeklyPercent !== "number"
      && hourlyPresent === undefined && weeklyPresent === undefined) return [];
    return [
      {
        modelKey: "codex",
        hourlyPercent: typeof a.codexHourlyPercent === "number" ? a.codexHourlyPercent : null,
        weeklyPercent: typeof a.codexWeeklyPercent === "number" ? a.codexWeeklyPercent : null,
        hourlyPresent,
        weeklyPresent,
        hourlyResetAt: parseSnapshotDate(a.codexHourlyResetTime),
        weeklyResetAt: parseSnapshotDate(a.codexWeeklyResetTime),
      },
    ];
  }

  quotaSnapshotInputsFromReport(quota: unknown, _account: CodexAccount) {
    const cq = (quota as any)?.codexQuota;
    if (!cq || typeof cq !== "object") return [];
    const rawHourly = Number(cq.hourlyPercent);
    const rawWeekly = Number(cq.weeklyPercent);
    const hourlyKnown = Number.isFinite(rawHourly) && rawHourly >= 0 && cq.hourlyPresent !== false;
    const weeklyKnown = Number.isFinite(rawWeekly) && rawWeekly >= 0 && cq.weeklyPresent !== false;
    const hourlyPresent = typeof cq.hourlyPresent === "boolean" ? cq.hourlyPresent : hourlyKnown ? true : undefined;
    const weeklyPresent = typeof cq.weeklyPresent === "boolean" ? cq.weeklyPresent : weeklyKnown ? true : undefined;
    if (!hourlyKnown && !weeklyKnown && hourlyPresent === undefined && weeklyPresent === undefined) return [];
    return [{
      modelKey: "codex",
      hourlyPercent: hourlyKnown ? clampPercent(rawHourly) : null,
      weeklyPercent: weeklyKnown ? clampPercent(rawWeekly) : null,
      hourlyPresent,
      weeklyPresent,
      hourlyResetAt: parseSnapshotDate(cq.hourlyResetTime),
      weeklyResetAt: parseSnapshotDate(cq.weeklyResetTime),
    }];
  }

  /**
   * Apply a client-reported Codex quota snapshot (from chatgpt.com
   * /backend-api/wham/accounts/check): hourly(5h) + weekly remaining percentages.
   * Codex has no per-model quota upstream, so the binding (more restrictive)
   * window maps to a single synthetic "codex" model-quota fraction — fuzzy-matched
   * by every codex model key in scoreAccount/cooldown. Raw percentages are kept
   * for console display. No credits concept.
   */
  applyQuotaSnapshot(account: CodexAccount, quota: any): { account: CodexAccount } {
    // 跨账号污染防护(系统性根因):客户端只有一份全局额度缓存,不认账号(codex_leaser.go
    // globalCodexLeaser 单例)。服务端换号接力/改绑(lease-service「账户级接力」)把卡从母号 X 换到
    // 母号 10 时,客户端缓存里可能还是 X 探来的额度,却随本次上报带来。客户端已把额度探自哪个号记在
    // accountQuota.accountId(codex_quota_sync.go) → 与本号 id 不符即丢弃,绝不让别号额度污染本号的
    // 显示与 fair-share 基线。缺 accountId(老格式)→ 不拦,向后兼容。
    const probedAccountId = Number((quota as any)?.accountId);
    if (Number.isFinite(probedAccountId) && probedAccountId > 0 && probedAccountId !== account.id) {
      return { account };
    }
    const acc = account as Record<string, unknown>;
    if (quota?.planType && typeof quota.planType === "string") {
      account.planType = quota.planType;
    }
    const cq = quota?.codexQuota;
    if (cq && typeof cq === "object") {
      const previousHourly = Number(acc.codexHourlyPercent ?? -1);
      const previousWeekly = Number(acc.codexWeeklyPercent ?? -1);
      const previousBinding = codexBindingWindow(previousHourly, previousWeekly);
      const rawHourly = Number(cq.hourlyPercent);
      const rawWeekly = Number(cq.weeklyPercent);
      const hourlyReset = cq.hourlyResetTime ? String(cq.hourlyResetTime) : "";
      const weeklyReset = cq.weeklyResetTime ? String(cq.weeklyResetTime) : "";

      // Contract (mirrors ClaudeProvider): the client reports a window whose
      // rate-limit data was absent on this upstream usage response as -1 — an
      // explicit "unknown", never a fabricated value. Fabricating a healthy 100
      // for an absent window would inflate the fair-share low-water mark, and the
      // next real (low) reading would then back-attribute the whole drop to the
      // active card in one shot → its blood bar sticks at 0 while the account
      // recovers. So: known = a finite, non-negative percent; -1 (or an absent
      // field → NaN) is unknown and keeps the last good value. A genuine 0 is 0.
      const hourlyKnown = Number.isFinite(rawHourly) && rawHourly >= 0 && cq.hourlyPresent !== false;
      const weeklyKnown = Number.isFinite(rawWeekly) && rawWeekly >= 0 && cq.weeklyPresent !== false;
      const hourlyPresence = typeof cq.hourlyPresent === "boolean" ? cq.hourlyPresent : hourlyKnown ? true : undefined;
      const weeklyPresence = typeof cq.weeklyPresent === "boolean" ? cq.weeklyPresent : weeklyKnown ? true : undefined;
      const presenceKnown = hourlyPresence !== undefined || weeklyPresence !== undefined;
      if (!hourlyKnown && !weeklyKnown && !presenceKnown) {
        // Report carried no usable window — don't touch persisted quota state.
        return { account };
      }

      const rawObservedAt = Number(quota?.observedAt ?? quota?.fetchedAt);
      const observedAt = Number.isFinite(rawObservedAt) && rawObservedAt > 0 ? rawObservedAt : Date.now();
      const previousObservedAt = Number(acc.codexQuotaObservedAt || 0);
      if (previousObservedAt > observedAt) return { account };
      acc.codexQuotaObservedAt = observedAt;

      if (hourlyPresence !== undefined) acc.codexHourlyPresent = hourlyPresence;
      if (weeklyPresence !== undefined) acc.codexWeeklyPresent = weeklyPresence;
      if (hourlyPresence === false) {
        delete acc.codexHourlyPercent;
        delete acc.codexHourlyResetTime;
      } else if (hourlyKnown) {
        acc.codexHourlyPercent = clampPercent(rawHourly);
        acc.codexHourlyResetTime = hourlyReset;
      }
      if (weeklyPresence === false) {
        delete acc.codexWeeklyPercent;
        delete acc.codexWeeklyResetTime;
      } else if (weeklyKnown) {
        acc.codexWeeklyPercent = clampPercent(rawWeekly);
        acc.codexWeeklyResetTime = weeklyReset;
      }

      const hourly = Number(acc.codexHourlyPercent ?? -1);
      const weekly = Number(acc.codexWeeklyPercent ?? -1);

      // Binding window = the more restrictive of the KNOWN windows; if one side
      // is unknown (-1), the other binds.
      let weeklyBinds: boolean;
      if (hourly < 0) weeklyBinds = true;
      else if (weekly < 0) weeklyBinds = false;
      else weeklyBinds = weekly < hourly;
      const bindingPercent = weeklyBinds ? weekly : hourly;
      const bindingWindow = codexBindingWindow(hourly, weekly);
      const bindingReset = weeklyBinds
        ? String(acc.codexWeeklyResetTime || "")
        : String(acc.codexHourlyResetTime || "");

      if (bindingPercent >= 0) account.modelQuotaFractions = { codex: bindingPercent / 100 };
      else if (account.modelQuotaFractions) delete (account.modelQuotaFractions as Record<string, number>).codex;
      // Only overwrite the reset time when we have one; a window without a reset
      // must not wipe a still-valid prior reset (cooldownForExhaustion relies on
      // it to park the account until real reset).
      if (bindingReset) {
        account.modelQuotaResetTimes = { codex: bindingReset };
      } else if ((bindingPercent < 0 || (presenceKnown && previousBinding !== null && bindingWindow !== null && previousBinding !== bindingWindow))
        && account.modelQuotaResetTimes) {
        delete (account.modelQuotaResetTimes as Record<string, string>).codex;
      } else if (!account.modelQuotaResetTimes) {
        account.modelQuotaResetTimes = {};
      }
      account.modelQuotaRefreshedAt = Date.now();

    }
    return { account };
  }
}
