import * as path from "path";
import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker } from "../../lease-core/lease-service";
import { QuotaProfileTracker } from "../../lease-core/quota-profile-tracker";
import { bucketFamily } from "../../lease-core/product-bucket";
import { FairShareTracker } from "../../token-server/fair-share-tracker";
import { RemoteAccessHttpError } from "../../remote-access/http-error";
import { defaultRemoteAccessDataDir } from "../../remote-access/data-dir";
import { ClaudeAccount } from "../auth/claude-token-provider";
import { ClaudeProvider } from "../claude.provider";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: ClaudeAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
};

/** HTTP error thrown by the claude lease server. Subclass so RemoteAnthropicController
 * can route on `instanceof`. */
export class RemoteAnthropicHttpError extends RemoteAccessHttpError {}

/**
 * Claude (Anthropic subscription OAuth) token server. A thin wrapper over the
 * generic LeaseService wired with the ClaudeProvider — it inherits the full
 * feature set (candidate retry, per-account cooldown, scoring, affinity, stats,
 * report dedup) the codex/antigravity flows already had.
 */
@Injectable()
export class RemoteAnthropicService extends LeaseService<ClaudeAccount> implements OnModuleDestroy {
  constructor(@Optional() options: ServiceOptions = {}) {
    const provider = new ClaudeProvider({
      accountsFilePath: options.accountsFilePath,
      tokenProvider: options.tokenProvider,
    });
    const quotaProfileTracker = new QuotaProfileTracker(
      path.join(defaultRemoteAccessDataDir(), "quota-profiles.json"),
    );
    let service: RemoteAnthropicService;
    // 多张卡拼一个 Claude 号时,按 weight/capacity 分份额(与 codex/antigravity 同一套)。
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
    });
    super(
      provider,
      {
        accessKeysFilePath: options.accessKeysFilePath,
        now: options.now,
        randomId: options.randomId,
        minClientVersion: options.minClientVersion,
        leaseTtlMs: options.leaseTtlMs,
        tokenUsageTracker: options.tokenUsageTracker,
        fairShareTracker,
        quotaProfileTracker,
        mode: "remote-anthropic-server",
        noAccountMessage: "No available Claude accounts",
        errorClass: RemoteAnthropicHttpError,
      },
    );
    service = this;
  }

  /** Periodically pull the live Claude model list from upstream (best-effort). */
  @Cron(CronExpression.EVERY_6_HOURS)
  async refreshModelCatalog(): Promise<void> {
    await this.refreshModels();
  }
}
