import { Module } from "@nestjs/common";

import { RemoteClaudeController } from "./controller/remote-claude.controller";
import { RemoteClaudeService } from "./service/remote-claude.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";

const remoteClaudeProvider = {
  provide: RemoteClaudeService,
  useFactory: (tokenUsageTracker: TokenUsageTracker) =>
    new RemoteClaudeService({ tokenUsageTracker }),
  inject: ["TOKEN_USAGE_TRACKER"],
};

@Module({
  imports: [TokenServerModule],
  controllers: [RemoteClaudeController],
  providers: [remoteClaudeProvider],
  exports: [RemoteClaudeService],
})
export class RemoteClaudeModule {}
