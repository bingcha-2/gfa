import { Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../account/customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../account/customer-auth/customer.decorator";
import type { CustomerUser } from "../account/customer-auth/customer-jwt.strategy";
import { ReferralService } from "../account/referral/referral.service";

/**
 * AppSurfaceController — desktop client surface (/api/app/*).
 *
 * Client-facing endpoints sit behind the Customer session JWT guard (the desktop
 * UserToken is a customer session, same as the web portal).
 */
@Controller("app")
export class AppSurfaceController {
  constructor(private readonly referral: ReferralService) {}

  @Public()
  @Get("health")
  health() {
    return { surface: "app", status: "ok" };
  }

  /**
   * POST /api/app/referral — 桌面端分享/邀请信息(复用 toC 的 ReferralService.getSummary)。
   * POST 而非 GET:与 app 面其它端点(heartbeat/logout)同口径,客户端用 doAuthPostWithBearer 调用。
   */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("referral")
  @HttpCode(200)
  referralSummary(@CurrentCustomer() customer: CustomerUser) {
    return this.referral.getSummary(customer.customerId);
  }
}
