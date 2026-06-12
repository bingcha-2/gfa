import { Module } from "@nestjs/common";

import { CustomerAdminController } from "./customer-admin.controller";
import { CustomerAdminService } from "./customer-admin.service";
import { SubscriptionModule } from "../../subscription/subscription.module";

/**
 * CustomerAdminModule — console customer-management surface (list / detail /
 * enable-disable / manual subscription grant). SubscriptionModule supplies
 * activateOrExtend; PrismaModule and AuditLogModule are @Global.
 */
@Module({
  imports: [SubscriptionModule],
  controllers: [CustomerAdminController],
  providers: [CustomerAdminService],
})
export class CustomerAdminModule {}
