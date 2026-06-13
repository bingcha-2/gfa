import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../../account/customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../../account/customer-auth/customer.decorator";
import { CustomerUser } from "../../account/customer-auth/customer-jwt.strategy";
import { AppAuthService } from "./app-auth.service";
import { AppLoginDto } from "./dto/app-login.dto";
import { HeartbeatDto } from "./dto/heartbeat.dto";
import { AppLogoutDto } from "./dto/logout.dto";

/**
 * AppAuthController — desktop/mobile client surface (/api/app/*).
 *
 * All endpoints are @Public() to skip the global admin JwtAuthGuard.
 * Authenticated endpoints explicitly apply CustomerJwtGuard.
 */
@Controller("app")
export class AppAuthController {
  constructor(private readonly appAuthService: AppAuthService) {}

  /**
   * POST /api/app/login
   * Rate limited: 10 requests per 60 seconds per IP.
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: AppLoginDto, @Request() req: any) {
    const lastIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
      req.socket?.remoteAddress ??
      undefined;

    return this.appAuthService.login({
      email: dto.email,
      password: dto.password,
      deviceId: dto.deviceId,
      deviceName: dto.deviceName,
      clientVersion: dto.clientVersion,
      platform: dto.platform,
      lastIp
    });
  }

  /**
   * POST /api/app/heartbeat
   * Updates lastSeenAt and validates device session is still active.
   */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("heartbeat")
  @HttpCode(HttpStatus.OK)
  heartbeat(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: HeartbeatDto
  ) {
    return this.appAuthService.heartbeat({
      customerId: customer.customerId,
      jti: customer.jti,
      tokenDeviceId: customer.deviceId,
      deviceId: dto.deviceId
    });
  }

  /**
   * POST /api/app/logout
   * Clears Device.sessionJti — keeps the device row, status stays ACTIVE.
   */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  logout(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: AppLogoutDto
  ) {
    return this.appAuthService.logout({
      customerId: customer.customerId,
      deviceId: dto.deviceId
    });
  }
}
