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
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

import { Roles } from "../auth/roles.decorator";
import { AuditLogService } from "../audit-log/audit-log.service";
import { RedeemCodeService } from "./redeem-code.service";

const VALID_CODE_TYPES = ["JOIN_GROUP", "ACCOUNT_SWAP"] as const;
type CodeType = typeof VALID_CODE_TYPES[number];

class BatchCreateDto {
  @IsInt()
  @Min(1)
  @Max(100)
  count!: number;

  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsEnum(VALID_CODE_TYPES)
  codeType?: CodeType;
}

@Controller("redeem-codes")
export class RedeemCodeController {
  constructor(
    private readonly redeemCodeService: RedeemCodeService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  @Roles("ADMIN", "OPERATIONS")
  findAll(@Query("status") status?: string) {
    return this.redeemCodeService.findAll(status);
  }

  @Post("batch-create")
  @Roles("ADMIN", "OPERATIONS")
  async batchCreate(@Body() dto: BatchCreateDto, @Request() req: any) {
    const codes = await this.redeemCodeService.batchCreate({
      count: dto.count,
      product: dto.product,
      codeType: dto.codeType,
      createdById: req.user.id
    });

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BATCH_CREATE_CODES",
      targetType: "RedeemCode",
      targetId: "batch",
      detail: { count: dto.count, product: dto.product ?? "GOOGLE_ONE", codeType: dto.codeType ?? "JOIN_GROUP" }
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
