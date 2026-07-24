import { Module } from "@nestjs/common";

import { PlanCatalogModule } from "../plan-catalog/plan-catalog.module";
import { SubscriptionModule } from "../subscription/subscription.module";
import { TrialService } from "./trial.service";

@Module({
  imports: [PlanCatalogModule, SubscriptionModule],
  providers: [TrialService],
  exports: [TrialService],
})
export class TrialModule {}
