import { Controller, Get } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";
import { PlanCatalogService } from "./plan-catalog.service";

/**
 * Public plan catalog — no authentication required (spec §7.2).
 * Returns the currently PUBLISHED catalog config (products/levels/usageTiers/
 * pricing) so the web purchase page / app can render the two lines and price
 * locally. Returns nulls when nothing is published yet.
 */
@Controller("plan-catalog")
@Public()
export class PlanCatalogPublicController {
  constructor(private readonly planCatalog: PlanCatalogService) {}

  @Get()
  async get() {
    const published = await this.planCatalog.getPublished();
    if (!published) return { version: null, config: null };
    return { version: published.version, config: published.config };
  }
}
