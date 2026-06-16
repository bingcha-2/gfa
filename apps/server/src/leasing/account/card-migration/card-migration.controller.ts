import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import type { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { CardMigrationService } from "./card-migration.service";
import { BindCardDto } from "./dto/bind-card.dto";

/**
 * POST /api/account/bind-card — migrate a legacy card key onto the logged-in
 * customer as a planless Subscription (id continuity with the old record).
 *
 * @Public() skips the global admin JwtAuthGuard; CustomerJwtGuard enforces a
 * customer session. @SkipThrottle(): binding is idempotent and self-serializes
 * under the access-keys write lock, so no rate limit — a logged-in customer
 * retrying a bind must never be blocked by the global throttler.
 */
@Controller("account")
export class CardMigrationController {
  constructor(private readonly cardMigration: CardMigrationService) {}

  @Public()
  @UseGuards(CustomerJwtGuard)
  @SkipThrottle()
  @Post("bind-card")
  bindCard(@CurrentCustomer() customer: CustomerUser, @Body() dto: BindCardDto) {
    return this.cardMigration.bindCard(customer.customerId, dto.cardKey);
  }
}
