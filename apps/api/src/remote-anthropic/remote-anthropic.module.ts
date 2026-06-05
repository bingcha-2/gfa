import { Module } from "@nestjs/common";

import { RemoteAnthropicController } from "./controller/remote-anthropic.controller";
import { RemoteAnthropicService } from "./service/remote-anthropic.service";
import { TokenUsageTracker } from "../token-server/token-usage-tracker";
import { TokenServerModule } from "../token-server/token-server.module";

const remoteAnthropicProvider = {
  provide: RemoteAnthropicService,
  useFactory: (tokenUsageTracker: TokenUsageTracker) =>
    new RemoteAnthropicService({ tokenUsageTracker }),
  inject: ["TOKEN_USAGE_TRACKER"],
};

@Module({
  imports: [TokenServerModule],
  controllers: [RemoteAnthropicController],
  providers: [remoteAnthropicProvider],
  exports: [RemoteAnthropicService],
})
export class RemoteAnthropicModule {}
