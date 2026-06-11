import {
  Body,
  Controller,
  Get,
  Param,
  Post
} from "@nestjs/common";
import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../auth/public.decorator";
import { OrderService } from "./order.service";

export class RedeemDto {
  @IsString()
  code!: string;

  @IsEmail()
  email!: string;
}

export class SwapAccountDto {
  @IsString()
  @MinLength(6)
  swapCode!: string;

  @IsString()
  orderNo!: string;

  @IsEmail()
  newEmail!: string;
}

export class SwapByEmailDto {
  @IsEmail()
  originalEmail!: string;

  @IsString()
  @MinLength(6)
  swapCode!: string;

  @IsEmail()
  newEmail!: string;
}

export class SubscriptionSwapDto {
  @IsString()
  @MinLength(6)
  originalCode!: string;

  @IsEmail()
  newEmail!: string;
}

@Controller("public")
export class OrderPublicController {
  constructor(private readonly orderService: OrderService) {}

  // S-03: Limit redeem attempts — 10 per 60 seconds
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("redeem")
  redeem(@Body() dto: RedeemDto) {
    return this.orderService.redeem(dto.code, dto.email);
  }

  // S-03: Limit order lookup — 20 per 60 seconds (prevents order-no enumeration)
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get("orders/:orderNo")
  findByOrderNo(@Param("orderNo") orderNo: string) {
    return this.orderService.findByOrderNo(orderNo);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get("orders/by-code/:code")
  findByRedeemCode(@Param("code") code: string) {
    return this.orderService.findByRedeemCode(code);
  }

  /** Customer self-service account swap (legacy — accepts orderNo) */
  // S-03: Limit swap attempts — 10 per 60 seconds
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("swap-account")
  swapAccount(@Body() dto: SwapAccountDto) {
    return this.orderService.swapAccountByOrderNo({
      swapCode: dto.swapCode,
      orderNo: dto.orderNo,
      newEmail: dto.newEmail
    });
  }

  /** Customer self-service account swap — by original email (no order number needed) */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("swap-by-email")
  swapByEmail(@Body() dto: SwapByEmailDto) {
    return this.orderService.swapAccountByEmail({
      swapCode: dto.swapCode,
      originalEmail: dto.originalEmail,
      newEmail: dto.newEmail
    });
  }

  /** Customer query swap task progress */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get("swap-status/:orderNo")
  findSwapStatus(@Param("orderNo") orderNo: string) {
    return this.orderService.findSwapStatus(orderNo);
  }

  /** SUBSCRIPTION code holder self-service swap (no extra code needed) */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("subscription-swap")
  subscriptionSwap(@Body() dto: SubscriptionSwapDto) {
    return this.orderService.subscriptionSwap({
      originalCode: dto.originalCode,
      newEmail: dto.newEmail
    });
  }

  /** Public self-service: check if member needs migration */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("check-migration")
  checkMigration(@Body() dto: { email: string }) {
    return this.orderService.checkMigration(dto.email ?? "");
  }

  /** Public self-service: execute migration */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post("self-migrate")
  selfMigrate(@Body() dto: { email: string }) {
    return this.orderService.selfMigrate(dto.email ?? "");
  }
}
