import { Module } from "@nestjs/common";

import { BillingAdminController } from "./billing-admin.controller";
import { BillingAdminService } from "./billing-admin.service";
import { SubscriptionModule } from "../../subscription/subscription.module";
import { BillingModule } from "../../account/billing/billing.module";

/**
 * BillingAdminModule — console refund/revoke surface for the subscription
 * billing system (plan orders + subscriptions). SubscriptionModule supplies
 * cancelSubscription (status flip + shadow-record expiry); BillingModule
 * supplies BillingService (epay order sync); AuditLogModule is @Global so
 * AuditLogService needs no import.
 */
@Module({
  imports: [SubscriptionModule, BillingModule],
  controllers: [BillingAdminController],
  providers: [BillingAdminService],
  exports: [BillingAdminService],
})
export class BillingAdminModule {}
