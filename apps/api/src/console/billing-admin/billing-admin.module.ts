import { Module } from "@nestjs/common";

import { BillingAdminController } from "./billing-admin.controller";
import { BillingAdminService } from "./billing-admin.service";
import { SubscriptionModule } from "../../subscription/subscription.module";

/**
 * BillingAdminModule — console refund/revoke surface for the subscription
 * billing system (plan orders + subscriptions). SubscriptionModule supplies
 * cancelSubscription (status flip + shadow-record expiry); AuditLogModule is
 * @Global so AuditLogService needs no import.
 */
@Module({
  imports: [SubscriptionModule],
  controllers: [BillingAdminController],
  providers: [BillingAdminService],
  exports: [BillingAdminService],
})
export class BillingAdminModule {}
