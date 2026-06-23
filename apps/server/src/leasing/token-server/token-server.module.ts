import { Inject, Module, OnModuleInit } from "@nestjs/common";

import { TokenServerController } from "./token-server.controller";
import { TokenServerService } from "./token-server.service";
import { TokenUsageTracker } from "./token-usage-tracker";
import { BanEventTracker } from "./ban-event-tracker";
import { RequestLogTracker } from "./request-log-tracker";
import { AccountQuotaSnapshotTracker } from "./account-quota-snapshot-tracker";
import { AccessKeyStore } from "./access-key-store";
import { SessionTokenResolver } from "./session-token-resolver";
import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { CustomerAuthModule } from "../account/customer-auth/customer-auth.module";

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

// 封号事件记录器。共享一份(内存环按 provider+accountId 隔离)。只被 codex/anthropic
// 模块注入(antigravity 不接 → 不记封号),见各自 module 的 BAN_EVENT_TRACKER inject。
const banEventTrackerProvider = {
  provide: "BAN_EVENT_TRACKER",
  useFactory: (prisma: PrismaService) => new BanEventTracker(prisma),
  inject: [PrismaService],
};

// per-request 热表写入器(72h)。同样只被 codex/anthropic 模块注入。
const requestLogTrackerProvider = {
  provide: "REQUEST_LOG_TRACKER",
  useFactory: (prisma: PrismaService) => new RequestLogTracker(prisma),
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
  providers: [tokenUsageTrackerProvider, accountQuotaSnapshotTrackerProvider, banEventTrackerProvider, requestLogTrackerProvider, sharedAccessKeyStoreProvider, tokenServerProvider, SessionTokenResolver],
  exports: [TokenServerService, "TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "BAN_EVENT_TRACKER", "REQUEST_LOG_TRACKER", "SHARED_ACCESS_KEY_STORE", SessionTokenResolver],
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
