import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request
} from "@nestjs/common";
import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";
import { Throttle } from "@nestjs/throttler";

import { Roles } from "../auth/roles.decorator";
import { Public } from "../auth/public.decorator";
import { AuditLogService } from "../audit-log/audit-log.service";
import { OrderService } from "./order.service";

class RedeemDto {
  @IsString()
  code!: string;

  @IsEmail()
  email!: string;
}

class SwapAccountDto {
  @IsString()
  @MinLength(6)
  swapCode!: string;

  @IsString()
  orderNo!: string;

  @IsEmail()
  newEmail!: string;
}

class SwapByEmailDto {
  @IsEmail()
  originalEmail!: string;

  @IsString()
  @MinLength(6)
  swapCode!: string;

  @IsEmail()
  newEmail!: string;
}

class SubscriptionSwapDto {
  @IsString()
  @MinLength(6)
  originalCode!: string;

  @IsEmail()
  newEmail!: string;
}

class ReplaceMemberDto {
  @IsEmail()
  targetMemberEmail!: string;

  @IsEmail()
  newUserEmail!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller()
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly auditLog: AuditLogService
  ) { }

  // ---- Public endpoints (no auth) ----

  // S-03: Limit redeem attempts — 10 per 60 seconds
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("public/redeem")
  redeem(@Body() dto: RedeemDto) {
    return this.orderService.redeem(dto.code, dto.email);
  }

  // S-03: Limit order lookup — 20 per 60 seconds (prevents order-no enumeration)
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get("public/orders/:orderNo")
  findByOrderNo(@Param("orderNo") orderNo: string) {
    return this.orderService.findByOrderNo(orderNo);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get("public/orders/by-code/:code")
  findByRedeemCode(@Param("code") code: string) {
    return this.orderService.findByRedeemCode(code);
  }

  /** Customer self-service account swap (legacy — accepts orderNo) */
  // S-03: Limit swap attempts — 10 per 60 seconds
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("public/swap-account")
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
  @Post("public/swap-by-email")
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
  @Get("public/swap-status/:orderNo")
  findSwapStatus(@Param("orderNo") orderNo: string) {
    return this.orderService.findSwapStatus(orderNo);
  }


  /** SUBSCRIPTION code holder self-service swap (no extra code needed) */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("public/subscription-swap")
  subscriptionSwap(@Body() dto: SubscriptionSwapDto) {
    return this.orderService.subscriptionSwap({
      originalCode: dto.originalCode,
      newEmail: dto.newEmail
    });
  }

  /** Public self-service: check if member needs migration */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("public/check-migration")
  checkMigration(@Body() dto: { email: string }) {
    return this.orderService.checkMigration(dto.email ?? "");
  }

  /** Public self-service: execute migration */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post("public/self-migrate")
  selfMigrate(@Body() dto: { email: string }) {
    return this.orderService.selfMigrate(dto.email ?? "");
  }


  // ---- Admin endpoints ----

  @Get("orders")
  @Roles("ADMIN", "OPERATIONS")
  findAll(
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.orderService.findAll(
      status,
      page ? parseInt(page, 10) : undefined,
      pageSize ? parseInt(pageSize, 10) : undefined,
    );
  }

  @Get("orders/:id")
  @Roles("ADMIN", "OPERATIONS")
  findOne(@Param("id") id: string) {
    return this.orderService.findOne(id);
  }

  @Post("orders/:id/replace-member")
  @Roles("ADMIN", "OPERATIONS")
  async replaceMember(
    @Param("id") id: string,
    @Body() dto: ReplaceMemberDto,
    @Request() req: any
  ) {
    const result = await this.orderService.replaceMember(
      id,
      dto.targetMemberEmail,
      dto.newUserEmail
    );

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "REPLACE_MEMBER",
      targetType: "Order",
      targetId: id,
      detail: {
        targetMemberEmail: dto.targetMemberEmail,
        newUserEmail: dto.newUserEmail,
        reason: dto.reason
      }
    });

    return result;
  }

  @Post("orders/:id/retry")
  @Roles("ADMIN", "OPERATIONS")
  async retryOrder(
    @Param("id") id: string,
    @Request() req: any
  ) {
    const result = await this.orderService.retryOrder(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "RETRY_ORDER",
      targetType: "Order",
      targetId: id,
      detail: { result }
    });

    return result;
  }
}
