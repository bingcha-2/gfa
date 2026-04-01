import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUE_NAMES } from "@gfa/shared";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.automation })
  ],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService]
})
export class AutomationModule {}
