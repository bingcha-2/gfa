import { Module } from "@nestjs/common";

import { CustomerAdminController } from "./customer-admin.controller";
import { CustomerAdminService } from "./customer-admin.service";

/**
 * CustomerAdminModule — console customer-management surface (list / detail /
 * enable-disable / profile edit). PrismaModule and AuditLogModule are @Global.
 */
@Module({
  controllers: [CustomerAdminController],
  providers: [CustomerAdminService],
})
export class CustomerAdminModule {}
