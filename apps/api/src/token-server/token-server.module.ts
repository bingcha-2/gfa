import { Module } from "@nestjs/common";

import { TokenServerController } from "./token-server.controller";
import { TokenServerService } from "./token-server.service";
import { TokenUsageTracker } from "./token-usage-tracker";
import { AccountQuotaSnapshotTracker } from "./account-quota-snapshot-tracker";
import { AccessKeyStore } from "./access-key-store";
import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import { PrismaService } from "../prisma/prisma.service";

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
  controllers: [TokenServerController],
  providers: [tokenUsageTrackerProvider, accountQuotaSnapshotTrackerProvider, sharedAccessKeyStoreProvider, tokenServerProvider],
  exports: [TokenServerService, "TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "SHARED_ACCESS_KEY_STORE"],
})
export class TokenServerModule {}
