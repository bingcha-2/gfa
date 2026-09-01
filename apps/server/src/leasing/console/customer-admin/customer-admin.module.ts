import { Module } from "@nestjs/common";

import { CustomerAdminController } from "./customer-admin.controller";
import { CustomerAdminService } from "./customer-admin.service";
import { BillingModule } from "../../account/billing/billing.module";
import { SubscriptionModule } from "../../subscription/subscription.module";

/**
 * CustomerAdminModule — console customer-management surface (list / detail /
 * enable-disable / profile edit / 目录版手动授予). PrismaModule and AuditLogModule
 * are @Global;BillingModule(createGrantOrder)+SubscriptionModule(activateForOrder)
 * 提供手动授予所需服务。
 */
@Module({
  imports: [BillingModule, SubscriptionModule],
  controllers: [CustomerAdminController],
  providers: [CustomerAdminService],
})
export class CustomerAdminModule {}
