import { Module } from "@nestjs/common";

import { RedeemCodeController } from "./redeem-code.controller";
import { RedeemCodeService } from "./redeem-code.service";

@Module({
  controllers: [RedeemCodeController],
  providers: [RedeemCodeService],
  exports: [RedeemCodeService]
})
export class RedeemCodeModule {}
