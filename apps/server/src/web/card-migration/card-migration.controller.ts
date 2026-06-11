import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import type { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { CardMigrationService } from "./card-migration.service";
import { BindCardDto } from "./dto/bind-card.dto";

/**
 * POST /api/web/bind-card — migrate a legacy card key onto the logged-in
 * customer as a planless Subscription (id continuity with the old record).
 *
 * @Public() skips the global admin JwtAuthGuard; CustomerJwtGuard enforces a
 * customer session. Rate limited: 5 requests per 60 seconds per IP.
 */
@Controller("web")
export class CardMigrationController {
  constructor(private readonly cardMigration: CardMigrationService) {}

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("bind-card")
  bindCard(@CurrentCustomer() customer: CustomerUser, @Body() dto: BindCardDto) {
    return this.cardMigration.bindCard(customer.customerId, dto.cardKey);
  }
}
