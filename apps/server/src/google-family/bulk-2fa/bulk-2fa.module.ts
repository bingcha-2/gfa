import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUE_NAMES } from "@gfa/shared";
import { Bulk2faController } from "./bulk-2fa.controller";
import { Bulk2faService } from "./bulk-2fa.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.bulk2fa })
  ],
  controllers: [Bulk2faController],
  providers: [Bulk2faService],
  exports: [Bulk2faService]
})
export class Bulk2faModule {}
