import { Module } from "@nestjs/common";

import { ClaudeSessionLeaseController } from "./claude-session-lease.controller";
import { RosettaController } from "./rosetta.controller";
import { RosettaService } from "./rosetta.service";
import { TokenUsageStatsService } from "./token-usage-stats.service";
import { TokenServerModule } from "../token-server/token-server.module";
import { RemoteCodexModule } from "../remote-codex/remote-codex.module";
import { RemoteAnthropicModule } from "../remote-anthropic/remote-anthropic.module";
import { AutomationModule } from "../../google-family/automation/automation.module";

@Module({
  imports: [TokenServerModule, RemoteCodexModule, RemoteAnthropicModule, AutomationModule],
  controllers: [RosettaController, ClaudeSessionLeaseController],
  providers: [RosettaService, TokenUsageStatsService],
  exports: [RosettaService, TokenUsageStatsService],
})
export class RosettaModule {}
