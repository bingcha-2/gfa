import { Controller, Get } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";
import { PlanService } from "./plan.service";

/**
 * Public plan catalog — no authentication required.
 * Returns only customer-safe fields for active plans.
 * The web portal reaches this through its authed proxy, but the endpoint
 * itself stays anonymous for future marketing use.
 */
@Controller("web/plans")
@Public()
export class PlanPublicController {
  constructor(private readonly planService: PlanService) {}

  @Get()
  list() {
    return this.planService.listPublic();
  }
}
