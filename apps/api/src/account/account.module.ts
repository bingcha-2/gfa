import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUE_NAMES } from "@gfa/shared";

import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.sync })
  ],
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService]
})
export class AccountModule {}
