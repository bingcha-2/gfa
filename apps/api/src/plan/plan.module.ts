import { Module } from "@nestjs/common";

import { PlanAdminController } from "./plan-admin.controller";
import { PlanPublicController } from "./plan-public.controller";
import { PlanService } from "./plan.service";

@Module({
  controllers: [PlanPublicController, PlanAdminController],
  providers: [PlanService],
  exports: [PlanService],
})
export class PlanModule {}
