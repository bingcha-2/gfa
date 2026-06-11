import { Controller, Get, Query, UseGuards } from "@nestjs/common";

import { Public } from "../../auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { PortalService } from "./portal.service";

/**
 * PortalController — customer web portal overview and usage history.
 *
 * All routes are @Public() (skip global admin JwtAuthGuard) but protected
 * by CustomerJwtGuard via @UseGuards.
 */
@Controller("web/portal")
@Public()
@UseGuards(CustomerJwtGuard)
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  /**
   * GET /api/web/portal/overview
   * → { customer, subscriptions, devices, unreadNotifications }
   */
  @Get("overview")
  overview(@CurrentCustomer() customer: CustomerUser) {
    return this.portalService.getOverview(customer.customerId);
  }
}

/**
 * UsageController — customer usage history (/api/web/usage).
 *
 * Separate @Controller path — usage conceptually belongs to portal domain
 * but lives at /api/web/usage per contract.
 */
@Controller("web/usage")
@Public()
@UseGuards(CustomerJwtGuard)
export class UsageController {
  constructor(private readonly portalService: PortalService) {}

  /**
   * GET /api/web/usage?page=&pageSize=&days=
   * days ∈ {1,7,30}, default 7; pageSize default 20 cap 100
   * → { records, total, page, pageSize }
   */
  @Get()
  usage(
    @CurrentCustomer() customer: CustomerUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("days") days?: string,
  ) {
    return this.portalService.getUsage(customer.customerId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      days: days ? parseInt(days, 10) : undefined,
    });
  }
}
