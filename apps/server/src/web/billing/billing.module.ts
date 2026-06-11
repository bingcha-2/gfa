/**
 * BillingModule — plan orders, epay QR payments, idempotent callback,
 * referral rewards.
 *
 * NOTE FOR COORDINATOR: This module must be added to AppModule.imports[]
 * in apps/server/src/app.module.ts. It is intentionally self-contained so the
 * coordinator can wire it without touching any files owned by billing.
 *
 *   import { BillingModule } from "./web/billing/billing.module";
 *   // add BillingModule to the imports array
 *
 * Dependencies:
 *   - PrismaModule (@Global) — no explicit import needed
 *   - CustomerAuthModule — provides CustomerJwtGuard + CustomerJwtStrategy
 *   - SubscriptionModule — provides SubscriptionService + EntitlementSyncService
 *   - ScheduleModule (already in AppModule via ScheduleModule.forRoot()) — the
 *     @Cron decorator works as long as ScheduleModule.forRoot() is registered
 *     once in the app, which it is.
 */
import { Module } from "@nestjs/common";

import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { EpayController } from "./epay.controller";
import { EpayCallbackService } from "./epay-callback.service";
import { OrderExpiryService } from "./order-expiry.service";
import { BillingReconcileService } from "./billing-reconcile.service";
import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { SubscriptionModule } from "../../subscription/subscription.module";

@Module({
  imports: [CustomerAuthModule, SubscriptionModule],
  controllers: [BillingController, EpayController],
  providers: [BillingService, EpayCallbackService, OrderExpiryService, BillingReconcileService],
  exports: [BillingService],
})
export class BillingModule {}
