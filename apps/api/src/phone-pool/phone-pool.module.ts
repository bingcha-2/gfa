import { Module } from "@nestjs/common";
import { PhonePoolController } from "./phone-pool.controller";
import { PhonePoolService } from "./phone-pool.service";

@Module({
  controllers: [PhonePoolController],
  providers: [PhonePoolService],
  exports: [PhonePoolService],
})
export class PhonePoolModule {}
