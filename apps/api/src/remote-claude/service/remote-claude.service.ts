import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker } from "../../lease-core/lease-service";
import { RemoteAccessHttpError } from "../../remote-access/http-error";
import { ClaudeAccount } from "../auth/claude-token-provider";
import { ClaudeProvider } from "../claude.provider";

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

/** HTTP error thrown by the claude lease server. Subclass so RemoteClaudeController
 * can route on `instanceof`. */
export class RemoteClaudeHttpError extends RemoteAccessHttpError {}

/**
 * Claude (Anthropic subscription OAuth) token server. A thin wrapper over the
 * generic LeaseService wired with the ClaudeProvider — it inherits the full
 * feature set (candidate retry, per-account cooldown, scoring, affinity, stats,
 * report dedup) the codex/antigravity flows already had.
 */
@Injectable()
export class RemoteClaudeService extends LeaseService<ClaudeAccount> implements OnModuleDestroy {
  constructor(@Optional() options: ServiceOptions = {}) {
    super(
      new ClaudeProvider({
        accountsFilePath: options.accountsFilePath,
        tokenProvider: options.tokenProvider,
      }),
      {
        accessKeysFilePath: options.accessKeysFilePath,
        now: options.now,
        randomId: options.randomId,
        minClientVersion: options.minClientVersion,
        leaseTtlMs: options.leaseTtlMs,
        tokenUsageTracker: options.tokenUsageTracker,
        mode: "remote-claude-server",
        noAccountMessage: "No available Claude accounts",
        errorClass: RemoteClaudeHttpError,
      },
    );
  }

  /** Periodically pull the live Claude model list from upstream (best-effort). */
  @Cron(CronExpression.EVERY_6_HOURS)
  async refreshModelCatalog(): Promise<void> {
    await this.refreshModels();
  }
}
