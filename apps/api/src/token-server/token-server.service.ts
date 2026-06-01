import { Injectable, Optional, OnModuleDestroy } from "@nestjs/common";

import { LeaseService, LeaseServiceHttpError, type CreditTracker, type TokenUsageTracker } from "../lease-core/lease-service";
import { AntigravityProvider } from "./antigravity.provider";
import { TokenAccount } from "./account-token-provider";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: TokenAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
  creditTracker?: CreditTracker;
  tokenUsageTracker?: TokenUsageTracker;
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
    super(
      new AntigravityProvider({
        accountsFilePath: options.accountsFilePath,
        tokenProvider: options.tokenProvider,
      }),
      {
        accessKeysFilePath: options.accessKeysFilePath,
        now: options.now,
        randomId: options.randomId,
        minClientVersion: options.minClientVersion,
        leaseTtlMs: options.leaseTtlMs,
        affinityTtlMs: options.affinityTtlMs,
        creditTracker: options.creditTracker,
        tokenUsageTracker: options.tokenUsageTracker,
        errorClass: TokenServerHttpError,
      },
    );
  }
}
