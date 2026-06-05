/**
 * Provider abstraction for the generic LeaseService.
 *
 * A Provider supplies only the pieces that genuinely differ between upstreams
 * (antigravity / codex / future). Everything else — candidate-scan retry,
 * account runtime state machine, cooldown routing, model gates, affinity,
 * scoring, stats, report dedup, lease lifecycle — lives in LeaseService and is
 * shared verbatim.
 *
 * Stage 1 keeps the seam set minimal: only the antigravity-specific bits that
 * would otherwise break a projectId-less provider are abstracted. Scoring and
 * cooldown read OPTIONAL account fields (modelQuotaFractions /
 * modelQuotaResetTimes) and degrade gracefully when a provider's accounts lack
 * them, so they stay in the generic core.
 */

import type { ProviderBilling } from "../token-server/token-billing";
import type { ModelCatalog } from "./model-catalog";

/** Result of applying a client-reported account-quota snapshot. */
export interface CreditDelta {
  oldAmount: number;
  newAmount: number;
  available: boolean;
  email: string;
}

export interface Provider<TAccount> {
  /** Stable id, e.g. "antigravity" | "codex". */
  id: string;

  /** Absolute path to this provider's account-pool JSON. */
  accountsFilePath: string;

  /** Refresh (or return cached) upstream access token for an account. */
  refreshToken(account: TAccount): Promise<string>;

  /** Normalize a raw JSON account record into the provider's account shape. */
  normalizeAccount(raw: any): TAccount;

  /**
   * Provider-specific eligibility on top of the generic enabled/refreshToken
   * checks. antigravity requires a projectId; codex returns true.
   */
  isAccountEligible(account: TAccount): boolean;

  /**
   * Apply a client-reported account-quota snapshot (credits / per-model quota
   * fractions for antigravity; no-op for codex). Pure latest-wins state sync.
   * Returns the (possibly mutated) account and a credit delta for once-only
   * consumption events, or null when there is no credit change.
   */
  applyQuotaSnapshot(account: TAccount, quota: any): { account: TAccount; creditDelta: CreditDelta | null };

  /** Extra fields merged into the lease-token response (antigravity: projectId). */
  leaseResponseExtras(account: TAccount): Record<string, unknown>;

  /**
   * Optional extra fields merged into each account entry of getStatus().quota.
   * Lets a provider surface upstream-specific quota detail for the console
   * without polluting the generic status shape — codex exposes its 5h/weekly
   * remaining percentages and reset times. Omitted providers add nothing.
   */
  statusAccountExtras?(account: TAccount): Record<string, unknown>;

  /** Per-provider model registry (list / classify / upstream refresh). */
  models?: ModelCatalog;

  /** Per-provider token-billing bucket scheme. Defaults to universal when omitted. */
  billing?: ProviderBilling;

  /**
   * Optional override for the 5h quota fraction used in account scoring.
   * Antigravity omits it (per-model fractions resolved generically). Codex
   * implements it because its quota is account-level, applying to every codex
   * model regardless of the exact model key. Returns 0..1, -1 (暂无), or null.
   */
  quotaFractionFor?(account: TAccount, modelKey: string): number | null;

  /**
   * Remaining upstream quota for the end-user "blood bar" — a 0..1 fraction plus
   * the epoch-ms timestamp the window next refills (0 if unknown). Codex reports
   * its account-level 5h/weekly binding window; antigravity reports the per-model
   * remaining fraction. "Unknown" / "暂无" is treated as full (1) so a fresh
   * account shows a full bar. Providers that omit it surface no blood bar.
   */
  bloodBarFraction?(account: TAccount, modelKey: string): { fraction: number; resetAt: number };

  /**
   * Optional: refresh the leased account's quota snapshot from upstream during a
   * lease, so the lease response carries fresh blood-bar windows — server-side,
   * no client reporting. Called best-effort with the freshly-refreshed access
   * token right before the account is persisted + the lease response built.
   * Implementations MUST throttle internally (lease is hot) and never throw.
   * Anthropic uses this (GET /api/oauth/usage); codex/antigravity omit it.
   */
  refreshQuotaOnLease?(account: TAccount, accessToken: string): Promise<void>;
}
