import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import { QUEUE_NAMES } from "@gfa/shared";
import { ExpireScanService } from "./expire-scan.service";
import { ExpireScanController } from "./expire-scan.controller";

@Module({
  imports: [
    // ScheduleModule.forRoot() is registered globally in AppModule — do not repeat here
    BullModule.registerQueue({ name: QUEUE_NAMES.remove })
  ],
  controllers: [ExpireScanController],
  providers: [ExpireScanService],
  exports: [ExpireScanService]
})
export class ExpireScanModule {}

