import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtGuard } from "./customer-jwt.guard";
import { CurrentCustomer } from "./customer.decorator";
import { CustomerUser } from "./customer-jwt.strategy";
import { RegisterDto } from "./dto/register.dto";
import { CustomerLoginDto } from "./dto/login.dto";
import { CustomerChangePasswordDto } from "./dto/change-password.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";

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
   * Returns HTTP 201 (Created) on success.
   */
  @Public()
  @HttpCode(201)
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
    return this.authService.refresh(customer.customerId);
  }

  /**
   * POST /api/web/auth/forgot-password
   * Rate limited: 3 requests per 60 seconds per IP.
   * ALWAYS returns {ok:true} — no account enumeration.
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post("forgot-password")
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  /**
   * POST /api/web/auth/reset-password
   * Consumes a RESET_PASSWORD token; bumps tokenVersion to revoke all sessions.
   */
  @Public()
  @Post("reset-password")
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  /**
   * POST /api/web/auth/request-verify-email
   * Requires a valid customer session. Rate limited: 3 requests per 60 seconds.
   */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post("request-verify-email")
  requestVerifyEmail(@CurrentCustomer() customer: CustomerUser) {
    return this.authService.requestVerifyEmail(customer.customerId);
  }

  /**
   * POST /api/web/auth/verify-email
   * Consumes a VERIFY_EMAIL token; sets emailVerified=true.
   */
  @Public()
  @Post("verify-email")
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }
}
