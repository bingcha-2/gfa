import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards
} from "@nestjs/common";

import { Public } from "../../auth/public.decorator";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtGuard } from "./customer-jwt.guard";
import { CurrentCustomer } from "./customer.decorator";
import { CustomerUser } from "./customer-jwt.strategy";
import { UpdateProfileDto } from "./dto/update-profile.dto";

/**
 * CustomerProfileController — customer profile read/update.
 *
 * All routes are @Public() to skip the global admin JwtAuthGuard, but
 * protected explicitly via CustomerJwtGuard.
 */
@Controller("web")
@Public()
@UseGuards(CustomerJwtGuard)
export class CustomerProfileController {
  constructor(private readonly authService: CustomerAuthService) {}

  /**
   * GET /api/web/me
   */
  @Get("me")
  async getMe(@CurrentCustomer() customer: CustomerUser) {
    const profile = await this.authService.getProfile(customer.customerId);
    return { customer: profile };
  }

  /**
   * PATCH /api/web/me
   */
  @Patch("me")
  async updateMe(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: UpdateProfileDto
  ) {
    const profile = await this.authService.updateProfile(
      customer.customerId,
      dto.displayName
    );
    return { customer: profile };
  }
}
