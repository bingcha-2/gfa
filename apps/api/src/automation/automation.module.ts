import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUE_NAMES } from "@gfa/shared";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";
import { AgentAccountController } from "./agent-account.controller";
import { AgentAccountService } from "./agent-account.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.automation })
  ],
  controllers: [AutomationController, AgentAccountController],
  providers: [AutomationService, AgentAccountService],
})
export class AutomationModule {}
