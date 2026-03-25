import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request
} from "@nestjs/common";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

import { Roles } from "../auth/roles.decorator";
import { AuditLogService } from "../audit-log/audit-log.service";
import { RedeemCodeService } from "./redeem-code.service";

class BatchCreateDto {
  @IsInt()
  @Min(1)
  @Max(100)
  count!: number;

  @IsOptional()
  @IsString()
  product?: string;
}

@Controller("redeem-codes")
export class RedeemCodeController {
  constructor(
    private readonly redeemCodeService: RedeemCodeService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  findAll(@Query("status") status?: string) {
    return this.redeemCodeService.findAll(status);
  }

  @Post("batch-create")
  @Roles("ADMIN", "OPERATIONS")
  async batchCreate(@Body() dto: BatchCreateDto, @Request() req: any) {
    const codes = await this.redeemCodeService.batchCreate({
      count: dto.count,
      product: dto.product,
      createdById: req.user.id
    });

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BATCH_CREATE_CODES",
      targetType: "RedeemCode",
      targetId: "batch",
      detail: { count: dto.count, product: dto.product ?? "GOOGLE_ONE" }
    });

    return codes;
  }

  @Patch(":id/disable")
  @Roles("ADMIN", "OPERATIONS")
  async disable(@Param("id") id: string, @Request() req: any) {
    const code = await this.redeemCodeService.disable(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "DISABLE_CODE",
      targetType: "RedeemCode",
      targetId: id
    });

    return code;
  }
}
