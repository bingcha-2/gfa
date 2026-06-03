import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker } from "../../lease-core/lease-service";
import { FairShareTracker } from "../../token-server/fair-share-tracker";
import { RemoteAccessHttpError } from "../../remote-access/http-error";
import { CodexAccount } from "../auth/codex-token-provider";
import { CodexProvider } from "../codex.provider";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: CodexAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
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

