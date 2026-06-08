import { Injectable, Optional, OnModuleDestroy } from "@nestjs/common";

import { LeaseService, LeaseServiceHttpError, type TokenUsageTracker, type AccountQuotaSnapshotRecorder } from "../lease-core/lease-service";
import { QuotaProfileTracker } from "../lease-core/quota-profile-tracker";
import { bucketFamily } from "../lease-core/product-bucket";
import { FairShareTracker } from "./fair-share-tracker";
import { AntigravityProvider } from "./antigravity.provider";
import { TokenAccount } from "./account-token-provider";
import { ACCOUNT_SHARE_CAPACITY } from "./token-billing";
import type { AccessKeyStore } from "./access-key-store";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: TokenAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
  accountQuotaSnapshotTracker?: AccountQuotaSnapshotRecorder;
  /** Shared AccessKeyStore so all product pools share one usage cache. */
  accessKeyStore?: AccessKeyStore;
  /** PrismaService — persists QuotaProfile/FairShareWindow (omit in unit tests). */
  prisma?: any;
};

/** HTTP error thrown by the antigravity token server. Subclass of the generic
 * lease error so TokenServerController can route on `instanceof`. */
export class TokenServerHttpError extends LeaseServiceHttpError {}

/**
 * Antigravity (Gemini + Claude/Opus) token server. A thin wrapper over the
 * generic LeaseService wired with the AntigravityProvider — all behavior lives
 * in LeaseService and is shared with the codex provider.
 */
@Injectable()
export class TokenServerService extends LeaseService<TokenAccount> implements OnModuleDestroy {
  constructor(@Optional() options: ServiceOptions = {}) {
    const provider = new AntigravityProvider({
      accountsFilePath: options.accountsFilePath,
      tokenProvider: options.tokenProvider,
    });
    // Quota profile tracker: learns real upstream budgets from 429 events.
    const quotaProfileTracker = new QuotaProfileTracker(options.prisma, { now: options.now });
    // Auto-create fair-share tracker wired to this service's own accessKeyStore.
    // Uses a deferred pattern: the tracker's callbacks reference `service` which
    // is assigned after super() returns.
    let service: TokenServerService;
    const fairShareTracker = new FairShareTracker({
      getAccountPlanType: (accountId: number) => {
        try {
          const status = service.getStatus();
          const acct = status.quota?.accounts?.find((a: any) => a.id === accountId);
          return acct?.planType || 'free';
        } catch { return 'free'; }
      },
      getBoundCardIds: (accountId: number) => {
        try {
          return service.accessKeyStore.cardsBoundToAccount(accountId, provider.id);
        } catch { return []; }
      },
      getCardWeight: (cardId: string) => {
        try {
          const record = service.accessKeyStore.findById(cardId);
          const w = Math.floor(Number((record as any)?.weight ?? 1));
          return (Number.isFinite(w) && w >= 1) ? Math.min(w, ACCOUNT_SHARE_CAPACITY) : 1;
        } catch { return 1; }
      },
      accountShareCapacity: ACCOUNT_SHARE_CAPACITY,
      getLearnedBudget: (planType: string, bucket: string) => {
        return quotaProfileTracker.getLearnedBudget5h(
          provider.id, planType, bucketFamily(bucket),
        );
      },
      prisma: options.prisma,
      provider: provider.id,
      now: options.now,
    });
    super(
      provider,
      {
        accessKeysFilePath: options.accessKeysFilePath,
        accessKeyStore: options.accessKeyStore,
        now: options.now,
        randomId: options.randomId,
        minClientVersion: options.minClientVersion,
        leaseTtlMs: options.leaseTtlMs,
        affinityTtlMs: options.affinityTtlMs,
        tokenUsageTracker: options.tokenUsageTracker,
        accountQuotaSnapshotTracker: options.accountQuotaSnapshotTracker,
        fairShareTracker,
        quotaProfileTracker,
        errorClass: TokenServerHttpError,
      },
    );
    service = this;
  }
}
