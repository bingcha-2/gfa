import { Controller, Get, UseGuards } from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { ReferralService } from "./referral.service";

/**
 * ReferralController — customer referral dashboard.
 *
 * Routes:
 *   GET /api/account/referral  — referral code, link, invitees, rewards summary, creditCents
 */
@Controller("account/referral")
@Public()
@UseGuards(CustomerJwtGuard)
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  /**
   * GET /api/account/referral
   * → { referralCode, referralLink, invitees:[{email,registeredAt,rewarded}],
   *     rewards:{totalCents,grantedCount}, creditCents }
   */
  @Get()
  getSummary(@CurrentCustomer() customer: CustomerUser) {
    return this.referralService.getSummary(customer.customerId);
  }
}
