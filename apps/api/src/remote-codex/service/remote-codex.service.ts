import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker, type AccountQuotaSnapshotRecorder } from "../../lease-core/lease-service";
import { QuotaProfileTracker } from "../../lease-core/quota-profile-tracker";
import { bucketFamily } from "../../lease-core/product-bucket";
import { FairShareTracker } from "../../token-server/fair-share-tracker";
import { RemoteAccessHttpError } from "../../remote-access/http-error";
import { CodexAccount } from "../auth/codex-token-provider";
import { CodexProvider } from "../codex.provider";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";
import type { AccessKeyStore } from "../../token-server/access-key-store";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  /** Shared AccessKeyStore so all product pools share one usage cache. */
  accessKeyStore?: AccessKeyStore;
  tokenProvider?: (account: CodexAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
  accountQuotaSnapshotTracker?: AccountQuotaSnapshotRecorder;
  /** PrismaService — persists QuotaProfile/FairShareWindow (omit in unit tests). */
  prisma?: any;
};

/** HTTP error thrown by the codex lease server. Subclass so RemoteCodexController
 * can route on `instanceof`. */
export class RemoteCodexHttpError extends RemoteAccessHttpError {}

/**
 * Codex (OpenAI) token server. A thin wrapper over the generic LeaseService
 * wired with the CodexProvider — it inherits the full feature set (candidate
 * retry, per-model cooldown, scoring, affinity, stats, report dedup) that the
 * antigravity flow already had.
 */
@Injectable()
export class RemoteCodexService extends LeaseService<CodexAccount> implements OnModuleDestroy {
  constructor(@Optional() options: ServiceOptions = {}) {
    const provider = new CodexProvider({
      accountsFilePath: options.accountsFilePath,
      tokenProvider: options.tokenProvider,
    });
    const quotaProfileTracker = new QuotaProfileTracker(options.prisma, { now: options.now });
    let service: RemoteCodexService;
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
      // Codex 上游有 5h + 周双限额 → 启用周公平份额第二层窗口。
      trackWeekly: true,
      getLearnedWeeklyBudget: (planType: string, bucket: string) => {
        return quotaProfileTracker.getLearnedBudgetWeekly(
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
        tokenUsageTracker: options.tokenUsageTracker,
        accountQuotaSnapshotTracker: options.accountQuotaSnapshotTracker,
        fairShareTracker,
        quotaProfileTracker,
        mode: "remote-codex-server",
        noAccountMessage: "No available Codex accounts",
        errorClass: RemoteCodexHttpError,
      },
    );
    service = this;
  }

  /** Periodically pull the live Codex model list from upstream (best-effort). */
  @Cron(CronExpression.EVERY_6_HOURS)
  async refreshModelCatalog(): Promise<void> {
    await this.refreshModels();
  }
}

