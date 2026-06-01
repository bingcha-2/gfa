import { Module } from "@nestjs/common";

import { TokenServerModule } from "../token-server/token-server.module";
import { RemoteCodexModule } from "../remote-codex/remote-codex.module";
import { RemoteStatsController } from "./remote-stats.controller";
import { RemoteStatsService } from "./remote-stats.service";

@Module({
  imports: [TokenServerModule, RemoteCodexModule],
  controllers: [RemoteStatsController],
  providers: [RemoteStatsService],
})
export class RemoteStatsModule {}
