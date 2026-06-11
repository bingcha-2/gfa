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

import { Roles } from "../../shared/auth/roles.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { OrderService } from "./order.service";

class ReplaceMemberDto {
  @IsEmail()
  targetMemberEmail!: string;

  @IsEmail()
  newUserEmail!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller(["orders", "console/orders"])
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly auditLog: AuditLogService
  ) { }

  @Get()
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

  @Get(":id")
  @Roles("ADMIN", "OPERATIONS")
  findOne(@Param("id") id: string) {
    return this.orderService.findOne(id);
  }

  @Post(":id/replace-member")
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

  @Post(":id/retry")
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
