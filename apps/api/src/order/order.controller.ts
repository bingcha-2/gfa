import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request
} from "@nestjs/common";
import { IsEmail, IsOptional, IsString } from "class-validator";

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
  ) {}

  // ---- Public endpoints (no auth) ----

  @Public()
  @Post("public/redeem")
  redeem(@Body() dto: RedeemDto) {
    return this.orderService.redeem(dto.code, dto.email);
  }

  @Public()
  @Get("public/orders/:orderNo")
  findByOrderNo(@Param("orderNo") orderNo: string) {
    return this.orderService.findByOrderNo(orderNo);
  }

  @Public()
  @Get("public/orders/by-code/:code")
  findByRedeemCode(@Param("code") code: string) {
    return this.orderService.findByRedeemCode(code);
  }

  // ---- Admin endpoints ----

  @Get("orders")
  findAll(@Query("status") status?: string) {
    return this.orderService.findAll(status);
  }

  @Get("orders/:id")
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
}
