import { Module } from "@nestjs/common";

import { RemoteCodexController } from "./controller/remote-codex.controller";
import { RemoteCodexService } from "./service/remote-codex.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { PlanCatalogModule } from "../plan-catalog/plan-catalog.module";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";
import { AccountQuotaEstimator } from "../token-server/account-quota-estimator";

const remoteCodexProvider = {
  provide: RemoteCodexService,
  useFactory: (tokenUsageTracker: TokenUsageTracker, accountQuotaSnapshotTracker: any, accountQuotaEstimator: AccountQuotaEstimator, banEventRecorder: any, requestLogRecorder: any, accessKeyStore: any, prisma: PrismaService, planCatalog: PlanCatalogService) =>
    new RemoteCodexService({
      tokenUsageTracker, accountQuotaSnapshotTracker, accountQuotaEstimator, banEventRecorder, requestLogRecorder,
      accessKeyStore, prisma,
      relayConfigProvider: async () => {
        const settings = await planCatalog.resolveCodexRelaySettings();
        return settings.enabled ? settings : null;
      },
      publishedCatalogProvider: () => planCatalog.getPublished(),
    }),
  inject: ["TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "ACCOUNT_QUOTA_ESTIMATOR", "BAN_EVENT_TRACKER", "REQUEST_LOG_TRACKER", "SHARED_ACCESS_KEY_STORE", PrismaService, PlanCatalogService],
};

@Module({
  imports: [TokenServerModule, PlanCatalogModule],
  controllers: [RemoteCodexController],
  providers: [remoteCodexProvider],
  exports: [RemoteCodexService],
})
export class RemoteCodexModule {}
