import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker, type AccountQuotaSnapshotRecorder } from "../../lease-core/lease-service";
import { FairShareTracker } from "../../token-server/fair-share-tracker";
import { RemoteAccessHttpError } from "../../remote-access/http-error";
import { ClaudeAccount } from "../auth/claude-token-provider";
import { ClaudeProvider } from "../claude.provider";
import type { AccessKeyStore } from "../../token-server/access-key-store";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  /** Shared AccessKeyStore so all product pools share one usage cache. */
  accessKeyStore?: AccessKeyStore;
  tokenProvider?: (account: ClaudeAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
  accountQuotaSnapshotTracker?: AccountQuotaSnapshotRecorder;
  /** PrismaService — persists FairShareWindow (omit in unit tests). */
  prisma?: any;
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
    let service: RemoteAnthropicService;
    // 多张卡拼一个 Claude 号时,按 weight/capacity 分份额(与 codex/antigravity 同一套)。
    const fairShareTracker = new FairShareTracker({
      getCardWeight: (cardId: string) => {
        const r: any = service.accessKeyStore.findById(cardId);
        // 按产品份额:weights[provider.id] 优先,否则回退卡级 weight。不再 clamp 到容量。
        const w = Math.floor(Number(r?.weights?.[provider.id] || 0) || Number(r?.weight ?? 1));
        return Number.isFinite(w) && w >= 1 ? w : 1;
      },
      getBoundCardWeights: (accountId: number) =>
        service.accessKeyStore.getHardBoundCardWeights(accountId, provider.id),
      getSeatCapacity: (accountId: number) =>
        service.accessKeyStore.getSeatCapacityFor(accountId, provider.id),
      isExclusive: (cardId: string) =>
        service.accessKeyStore.isExclusiveCard(cardId),
      // Claude 上游有 5h + 周双限额 → 启用周公平份额第二层窗口。
      trackWeekly: true,
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
