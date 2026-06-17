import { Module } from "@nestjs/common";

import { PlanCatalogService } from "./plan-catalog.service";
import { PlanCatalogPublicController } from "./plan-catalog-public.controller";
import { PlanCatalogAdminController } from "./plan-catalog-admin.controller";
import { QuotaBaselineService } from "./quota-baseline.service";

/**
 * PlanCatalogModule — versioned plan catalog (spec §4.1 / §7).
 *  - PlanCatalogPublicController: GET /api/plan-catalog (public, for clients).
 *  - PlanCatalogAdminController: console draft/publish (ConsoleJwtGuard + roles, audited).
 * PrismaModule is @Global; AuditLogModule is @Global (AuditLogService injectable).
 * Exports the service so the catalog-order path can read the PUBLISHED catalog
 * when pricing a selection.
 */
@Module({
  controllers: [PlanCatalogPublicController, PlanCatalogAdminController],
  providers: [PlanCatalogService, QuotaBaselineService],
  exports: [PlanCatalogService, QuotaBaselineService],
})
export class PlanCatalogModule {}
