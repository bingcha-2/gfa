import { Module } from "@nestjs/common";

import { TokenServerModule } from "../token-server/token-server.module";
import { RemoteCodexModule } from "../remote-codex/remote-codex.module";
import { RemoteAnthropicModule } from "../remote-anthropic/remote-anthropic.module";
import { RosettaModule } from "../rosetta/rosetta.module";
import { RemoteStatsController } from "./remote-stats.controller";
import { RemoteStatsService } from "./remote-stats.service";

@Module({
  imports: [TokenServerModule, RemoteCodexModule, RemoteAnthropicModule, RosettaModule],
  controllers: [RemoteStatsController],
  providers: [RemoteStatsService],
})
export class RemoteStatsModule {}
