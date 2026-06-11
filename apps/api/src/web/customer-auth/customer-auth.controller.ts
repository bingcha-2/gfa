import {
  Body,
  Controller,
  Post,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../auth/public.decorator";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtGuard } from "./customer-jwt.guard";
import { CurrentCustomer } from "./customer.decorator";
import { CustomerUser } from "./customer-jwt.strategy";
import { RegisterDto } from "./dto/register.dto";
import { CustomerLoginDto } from "./dto/login.dto";
import { CustomerChangePasswordDto } from "./dto/change-password.dto";

/**
 * CustomerAuthController — all endpoints are @Public() to skip the global
 * admin JwtAuthGuard. Guarded endpoints explicitly apply CustomerJwtGuard.
 */
@Controller("web/auth")
export class CustomerAuthController {
  constructor(private readonly authService: CustomerAuthService) {}

  /**
   * POST /api/web/auth/register
   * Rate limited: 5 requests per 60 seconds per IP.
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /**
   * POST /api/web/auth/login
   * Rate limited: 10 requests per 60 seconds per IP.
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("login")
  login(@Body() dto: CustomerLoginDto) {
    return this.authService.login(dto);
  }

  /**
   * POST /api/web/auth/change-password
   * Requires a valid customer session. Bumps tokenVersion → revokes all tokens.
   */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("change-password")
  changePassword(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: CustomerChangePasswordDto
  ) {
    return this.authService.changePassword(
      customer.customerId,
      dto.currentPassword,
      dto.newPassword
    );
  }

  /**
   * POST /api/web/auth/refresh
   * Re-signs a new token with the current tokenVersion.
   * Does NOT extend the session — just issues a fresh JWT with the same tv.
   */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("refresh")
  refresh(@CurrentCustomer() customer: CustomerUser) {
    return this.authService.refresh(customer.customerId, 0 /* unused */);
  }
}
