import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import { QUEUE_NAMES } from "@gfa/shared";
import { RedeemCodeModule } from "../redeem-code/redeem-code.module";
import { FamilyGroupModule } from "../family-group/family-group.module";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.invite },
      { name: QUEUE_NAMES.replace },
      { name: QUEUE_NAMES.sync }
    ),
    RedeemCodeModule,
    FamilyGroupModule
  ],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [OrderService]
})
export class OrderModule {}
