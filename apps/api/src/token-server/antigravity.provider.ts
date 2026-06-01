import * as path from "path";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import type { CreditDelta, Provider } from "../lease-core/provider";
import { refreshGoogleAccessToken, TokenAccount } from "./account-token-provider";
import { AntigravityModelCatalog } from "./antigravity-model-catalog";
// Billing is universal (one card spans all providers) — see UNIVERSAL_BILLING.
// Providers no longer override it; the AccessKeyStore default applies.

export type AntigravityProviderOptions = {
  accountsFilePath?: string;
  tokenProvider?: (account: TokenAccount) => Promise<string>;
};

/**
 * Antigravity (Gemini + Claude/Opus via Antigravity IDE Google OAuth).
 * The reference provider — its behavior is the byte-identical baseline the
 * existing token-server specs guard.
 */
export class AntigravityProvider implements Provider<TokenAccount> {
  readonly id = "antigravity";
  readonly accountsFilePath: string;
  readonly models = new AntigravityModelCatalog();
  private readonly tokenProvider: (account: TokenAccount) => Promise<string>;

  constructor(options: AntigravityProviderOptions = {}) {
    this.accountsFilePath = options.accountsFilePath || path.join(defaultRemoteAccessDataDir(), "accounts.json");
    this.tokenProvider = options.tokenProvider || refreshGoogleAccessToken;
  }

  refreshToken(account: TokenAccount): Promise<string> {
    return this.tokenProvider(account);
  }

  normalizeAccount(raw: any): TokenAccount {
    return {
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      projectId: String(raw.projectId || "").trim(),
      enabled: raw.enabled !== false,
    };
  }

  isAccountEligible(account: TokenAccount): boolean {
    return Boolean(account.projectId);
  }

  leaseResponseExtras(account: TokenAccount): Record<string, unknown> {
    return { projectId: account.projectId };
  }

  /**
   * Apply a client-reported Google account-quota snapshot: credits state,
   * planType, per-model quota fractions + reset times. Pure latest-wins state
   * sync (idempotent). Returns the credit delta so the caller can emit a
   * once-only consumption event, or null if no credits in the snapshot.
   */
  applyQuotaSnapshot(account: TokenAccount, quota: any): { account: TokenAccount; creditDelta: CreditDelta | null } {
    let delta: CreditDelta | null = null;
    if (quota.credits && typeof quota.credits === "object") {
      const oldAmount = Number(account.credits?.creditAmount || 0);
      const newAmount = Number(quota.credits.creditAmount || 0);
      delta = { oldAmount, newAmount, available: quota.credits.available !== false, email: account.email };
      account.credits = {
        known: Boolean(quota.credits.known),
        available: Boolean(quota.credits.available),
        creditAmount: newAmount,
        minCreditAmount: Number(quota.credits.minCreditAmount || 0),
        paidTierID: String(quota.credits.paidTierID || ""),
        creditsRefreshedAt: new Date().toISOString(),
      };
    }
    if (quota.planType && typeof quota.planType === "string") {
      account.planType = quota.planType;
    }
    if (quota.modelQuota && typeof quota.modelQuota === "object") {
      // Preserve a model's prior reset time when the new snapshot for that model
      // omits one — otherwise an update without resetTime wipes a still-valid reset
      // and cooldownForExhaustion loses the ability to park until the real reset.
      const prevResetTimes = (account.modelQuotaResetTimes || {}) as Record<string, string>;
      account.modelQuotaFractions = {};
      account.modelQuotaResetTimes = {};
      for (const [key, info] of Object.entries(quota.modelQuota as Record<string, any>)) {
        account.modelQuotaFractions[key] = Number(info?.remainingFraction || 0);
        if (info?.resetTime) {
          account.modelQuotaResetTimes[key] = String(info.resetTime);
        } else if (prevResetTimes[key]) {
          account.modelQuotaResetTimes[key] = String(prevResetTimes[key]);
        }
      }
      account.modelQuotaRefreshedAt = Date.now();
      this.models.observe(Object.keys(quota.modelQuota));
    }
    return { account, creditDelta: delta };
  }
}
