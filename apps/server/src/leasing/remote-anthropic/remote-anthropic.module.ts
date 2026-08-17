import { Module } from "@nestjs/common";

import { RemoteAnthropicController } from "./controller/remote-anthropic.controller";
import { RemoteAnthropicService } from "./service/remote-anthropic.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { AccountQuotaEstimator } from "../token-server/account-quota-estimator";

const remoteAnthropicProvider = {
  provide: RemoteAnthropicService,
  useFactory: (tokenUsageTracker: TokenUsageTracker, accountQuotaSnapshotTracker: any, accountQuotaEstimator: AccountQuotaEstimator, banEventRecorder: any, requestLogRecorder: any, accessKeyStore: any, prisma: PrismaService) =>
    new RemoteAnthropicService({ tokenUsageTracker, accountQuotaSnapshotTracker, accountQuotaEstimator, banEventRecorder, requestLogRecorder, accessKeyStore, prisma }),
  inject: ["TOKEN_USAGE_TRACKER", "ACCOUNT_QUOTA_SNAPSHOT_TRACKER", "ACCOUNT_QUOTA_ESTIMATOR", "BAN_EVENT_TRACKER", "REQUEST_LOG_TRACKER", "SHARED_ACCESS_KEY_STORE", PrismaService],
};

@Module({
  imports: [TokenServerModule],
  controllers: [RemoteAnthropicController],
  providers: [remoteAnthropicProvider],
  exports: [RemoteAnthropicService],
})
export class RemoteAnthropicModule {}
