import { Module } from "@nestjs/common";

import { PlanCatalogService } from "./plan-catalog.service";
import { PlanCatalogPublicController } from "./plan-catalog-public.controller";

/**
 * PlanCatalogModule — versioned plan catalog (spec §4.1 / §7).
 *  - PlanCatalogPublicController: GET /api/plan-catalog (public, for clients).
 * PrismaModule is @Global. Exports the service so the catalog-order path can
 * read the PUBLISHED catalog when pricing a selection.
 */
@Module({
  controllers: [PlanCatalogPublicController],
  providers: [PlanCatalogService],
  exports: [PlanCatalogService],
})
export class PlanCatalogModule {}
