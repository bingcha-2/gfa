import { Module } from "@nestjs/common";

import { RemoteCodexController } from "./controller/remote-codex.controller";
import { RemoteCodexService } from "./service/remote-codex.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";

const remoteCodexProvider = {
  provide: RemoteCodexService,
  useFactory: (tokenUsageTracker: TokenUsageTracker) =>
    new RemoteCodexService({ tokenUsageTracker }),
  inject: ["TOKEN_USAGE_TRACKER"],
};

@Module({
  imports: [TokenServerModule],
  controllers: [RemoteCodexController],
  providers: [remoteCodexProvider],
  exports: [RemoteCodexService],
})
export class RemoteCodexModule {}
