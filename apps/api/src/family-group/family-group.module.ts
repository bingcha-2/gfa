import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import { QUEUE_NAMES } from "@gfa/shared";
import { FamilyGroupController } from "./family-group.controller";
import { FamilyGroupService } from "./family-group.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.sync }),
    BullModule.registerQueue({ name: QUEUE_NAMES.remove })
  ],
  controllers: [FamilyGroupController],
  providers: [FamilyGroupService],
  exports: [FamilyGroupService]
})
export class FamilyGroupModule {}
