import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import { QUEUE_NAMES } from "@gfa/shared";
import { TaskController } from "./task.controller";
import { TaskService } from "./task.service";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.invite },
      { name: QUEUE_NAMES.remove },
      { name: QUEUE_NAMES.replace },
      { name: QUEUE_NAMES.sync },
      { name: QUEUE_NAMES.health }
    )
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService]
})
export class TaskModule {}
