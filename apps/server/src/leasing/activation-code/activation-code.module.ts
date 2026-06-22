import { Module } from "@nestjs/common";

import { ActivationCodeController } from "./activation-code.controller";
import { ActivationCodeAdminController } from "./activation-code-admin.controller";
import { ActivationCodeService } from "./activation-code.service";
import { CustomerAuthModule } from "../account/customer-auth/customer-auth.module";
import { BillingModule } from "../account/billing/billing.module";
import { SubscriptionModule } from "../subscription/subscription.module";
import { PlanCatalogModule } from "../plan-catalog/plan-catalog.module";

/**
 * ActivationCodeModule — 激活码生成(console)+ 兑换激活(account)。
 *  - BillingModule: createActivationCodeOrder(computePurchase 算价 + 座位预检)。
 *  - SubscriptionModule: activateForOrder(forceNew 开通独立订阅)。
 *  - PlanCatalogModule: 生成时校验 selection 形态。
 *  - CustomerAuthModule: account 端 CustomerJwtGuard。
 * PrismaModule / AuditLogModule 为 @Global。
 */
@Module({
  imports: [CustomerAuthModule, BillingModule, SubscriptionModule, PlanCatalogModule],
  controllers: [ActivationCodeController, ActivationCodeAdminController],
  providers: [ActivationCodeService],
  exports: [ActivationCodeService],
})
export class ActivationCodeModule {}
