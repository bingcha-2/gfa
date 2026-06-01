import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { LeaseService, type TokenUsageTracker } from "../../lease-core/lease-service";
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
    super(
      new CodexProvider({
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
        mode: "remote-codex-server",
        noAccountMessage: "No available Codex accounts",
        errorClass: RemoteCodexHttpError,
      },
    );
  }

  /** Periodically pull the live Codex model list from upstream (best-effort). */
  @Cron(CronExpression.EVERY_6_HOURS)
  async refreshModelCatalog(): Promise<void> {
    await this.refreshModels();
  }
}
