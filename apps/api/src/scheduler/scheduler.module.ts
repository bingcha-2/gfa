import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUE_NAMES } from "@gfa/shared";
import { SchedulerService } from "./scheduler.service";
import { SchedulerController } from "./scheduler.controller";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.sync }),
    BullModule.registerQueue({ name: QUEUE_NAMES.remove }),
  ],
  controllers: [SchedulerController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
