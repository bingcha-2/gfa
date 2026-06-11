import {
  Body,
  Controller,
  Delete,
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

const VALID_CODE_TYPES = ["JOIN_GROUP", "ACCOUNT_SWAP", "SUBSCRIPTION"] as const;
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

  /** SUBSCRIPTION: validity period in days */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  validDays?: number;

  /** SUBSCRIPTION: max swaps per rolling window */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  swapLimit?: number;

  /** SUBSCRIPTION: rolling window in hours */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  swapWindowHours?: number;
}

@Controller(["redeem-codes", "console/redeem-codes"])
export class RedeemCodeController {
  constructor(
    private readonly redeemCodeService: RedeemCodeService,
    private readonly auditLog: AuditLogService
  ) { }

  @Get()
  @Roles("ADMIN", "OPERATIONS")
  findAll(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("status") status?: string,
    @Query("codeType") codeType?: string,
    @Query("skipStats") skipStats?: string,
    @Query("search") search?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortOrder") sortOrder?: string
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const sizeNum = pageSize ? parseInt(pageSize, 10) : 30;
    return this.redeemCodeService.findAll(
      pageNum,
      sizeNum,
      status,
      codeType,
      skipStats === "true",
      search?.trim(),
      sortBy,
      sortOrder
    );
  }

  @Post("batch-create")
  @Roles("ADMIN", "OPERATIONS")
  async batchCreate(@Body() dto: BatchCreateDto, @Request() req: any) {
    const codes = await this.redeemCodeService.batchCreate({
      count: dto.count,
      product: dto.product,
      codeType: dto.codeType,
      createdById: req.user.id,
      validDays: dto.validDays,
      swapLimit: dto.swapLimit,
      swapWindowHours: dto.swapWindowHours
    });

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BATCH_CREATE_CODES",
      targetType: "RedeemCode",
      targetId: "batch",
      detail: {
        count: dto.count,
        product: dto.product ?? "GOOGLE_ONE",
        codeType: dto.codeType ?? "JOIN_GROUP",
        ...(dto.codeType === "SUBSCRIPTION" ? { validDays: dto.validDays, swapLimit: dto.swapLimit, swapWindowHours: dto.swapWindowHours } : {})
      }
    });

    return codes;
  }

  @Post("cleanup-expired")
  @Roles("ADMIN", "OPERATIONS")
  async cleanupExpired(@Request() req: any) {
    const result = await this.redeemCodeService.cleanupExpiredCodes();

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CLEANUP_EXPIRED_CODES",
      targetType: "RedeemCode",
      targetId: "expired",
      detail: result
    });

    return result;
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

  @Delete(":id")
  @Roles("ADMIN", "OPERATIONS")
  async remove(@Param("id") id: string, @Request() req: any) {
    const result = await this.redeemCodeService.remove(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "DELETE_CODE",
      targetType: "RedeemCode",
      targetId: id,
      detail: { code: result.code }
    });

    return result;
  }
}
