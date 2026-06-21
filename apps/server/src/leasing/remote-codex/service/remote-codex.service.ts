import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker, type AccountQuotaSnapshotRecorder } from "../../lease-core/lease-service";
import { FairShareTracker } from "../../token-server/fair-share-tracker";
import { RemoteAccessHttpError } from "../../remote-access/http-error";
import { CodexAccount } from "../auth/codex-token-provider";
import { CodexProvider } from "../codex.provider";
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
  /** PrismaService — persists FairShareWindow (omit in unit tests). */
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
    let service: RemoteCodexService;
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
      // Codex 上游有 5h + 周双限额 → 启用周公平份额第二层窗口。
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

