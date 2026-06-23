import { Module } from "@nestjs/common";

import { RemoteCodexController } from "./controller/remote-codex.controller";
import { RemoteCodexService } from "./service/remote-codex.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";
import { PrismaService } from "../../shared/prisma/prisma.service";

const remoteCodexProvider = {
  provide: RemoteCodexService,
  useFactory: (tokenUsageTracker: TokenUsageTracker, accountQuotaSnapshotTracker: any, banEventRecorder: any, requestLogRecorder: any, accessKeyStore: any, prisma: PrismaService) =>
    new RemoteCodexService({ tokenUsageTracker, accountQuotaSnapshotTracker, banEventRecorder, requestLogRecorder, accessKeyStore, prisma }),
  inject: ["TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "BAN_EVENT_TRACKER", "REQUEST_LOG_TRACKER", "SHARED_ACCESS_KEY_STORE", PrismaService],
};

@Module({
  imports: [TokenServerModule],
  controllers: [RemoteCodexController],
  providers: [remoteCodexProvider],
  exports: [RemoteCodexService],
})
export class RemoteCodexModule {}
