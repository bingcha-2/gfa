import { Module } from "@nestjs/common";

import { RemoteCodexController } from "./controller/remote-codex.controller";
import { RemoteCodexService } from "./service/remote-codex.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { PlanCatalogModule } from "../plan-catalog/plan-catalog.module";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";

const remoteCodexProvider = {
  provide: RemoteCodexService,
  useFactory: (tokenUsageTracker: TokenUsageTracker, accountQuotaSnapshotTracker: any, banEventRecorder: any, requestLogRecorder: any, accessKeyStore: any, prisma: PrismaService, planCatalog: PlanCatalogService) =>
    new RemoteCodexService({
      tokenUsageTracker, accountQuotaSnapshotTracker, banEventRecorder, requestLogRecorder,
      accessKeyStore, prisma,
      relayConfigProvider: async () => {
        const settings = await planCatalog.resolveCodexRelaySettings();
        return settings.enabled ? settings : null;
      },
    }),
  inject: ["TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "BAN_EVENT_TRACKER", "REQUEST_LOG_TRACKER", "SHARED_ACCESS_KEY_STORE", PrismaService, PlanCatalogService],
};

@Module({
  imports: [TokenServerModule, PlanCatalogModule],
  controllers: [RemoteCodexController],
  providers: [remoteCodexProvider],
  exports: [RemoteCodexService],
})
export class RemoteCodexModule {}
