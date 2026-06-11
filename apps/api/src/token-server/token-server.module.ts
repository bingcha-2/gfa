import { Inject, Module, OnModuleInit } from "@nestjs/common";

import { TokenServerController } from "./token-server.controller";
import { TokenServerService } from "./token-server.service";
import { TokenUsageTracker } from "./token-usage-tracker";
import { AccountQuotaSnapshotTracker } from "./account-quota-snapshot-tracker";
import { AccessKeyStore } from "./access-key-store";
import { SessionTokenResolver } from "./session-token-resolver";
import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import { PrismaService } from "../prisma/prisma.service";
import { CustomerAuthModule } from "../web/customer-auth/customer-auth.module";

// ONE AccessKeyStore shared by every product pool (antigravity/codex/anthropic).
// A universal card is used across all three; separate per-pool stores over the
// same access-keys.json blind-overwrite each other's usage, so per-card limits
// never trip. Sharing one cache/writer keeps the card's usage consistent.
const sharedAccessKeyStoreProvider = {
  provide: "SHARED_ACCESS_KEY_STORE",
  useFactory: () => new AccessKeyStore(`${defaultRemoteAccessDataDir()}/access-keys.json`),
};

const tokenUsageTrackerProvider = {
  provide: "TOKEN_USAGE_TRACKER",
  useFactory: (prisma: PrismaService) => new TokenUsageTracker(prisma),
  inject: [PrismaService],
};

const accountQuotaSnapshotTrackerProvider = {
  provide: "ACCOUNT_QUOTA_SNAPSHOT_TRACKER",
  useFactory: (prisma: PrismaService) => new AccountQuotaSnapshotTracker(prisma),
  inject: [PrismaService],
};

const tokenServerProvider = {
  provide: TokenServerService,
  useFactory: (
    tokenUsageTracker: TokenUsageTracker,
    accountQuotaSnapshotTracker: AccountQuotaSnapshotTracker,
    accessKeyStore: AccessKeyStore,
    prisma: PrismaService,
  ) => new TokenServerService({ tokenUsageTracker, accountQuotaSnapshotTracker, accessKeyStore, prisma }),
  inject: ["TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "SHARED_ACCESS_KEY_STORE", PrismaService],
};

@Module({
  // CustomerAuthModule provides CustomerTokenService for the session resolver
  // (verifies customer session JWTs on the lease hot path).
  imports: [CustomerAuthModule],
  controllers: [TokenServerController],
  providers: [tokenUsageTrackerProvider, accountQuotaSnapshotTrackerProvider, sharedAccessKeyStoreProvider, tokenServerProvider, SessionTokenResolver],
  exports: [TokenServerService, "TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "SHARED_ACCESS_KEY_STORE", SessionTokenResolver],
})
export class TokenServerModule implements OnModuleInit {
  constructor(
    @Inject("SHARED_ACCESS_KEY_STORE") private readonly accessKeyStore: AccessKeyStore,
    private readonly sessionTokenResolver: SessionTokenResolver,
  ) {}

  /**
   * Wire the customer-session resolver into the shared store. The store is a
   * plain TS class (no DI) shared across the three product pools, so the Nest
   * side injects the resolver post-construction — mirroring how the fair-share
   * tracker reaches the store ecosystem via deferred wiring.
   */
  onModuleInit(): void {
    this.accessKeyStore.setSessionResolver(this.sessionTokenResolver);
  }
}
