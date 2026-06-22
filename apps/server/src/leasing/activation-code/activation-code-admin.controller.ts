import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../shared/auth/console-jwt.guard";
import { Roles } from "../../shared/auth/roles.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { ActivationCodeService } from "./activation-code.service";
import { GenerateActivationCodesDto } from "./dto/generate-activation-codes.dto";

/**
 * Console 激活码管理 — 生成 / 列表 / 停用 / 导出。
 * ConsoleJwtGuard + ADMIN|OPERATIONS,变更操作审计(mirrors PlanCatalogAdminController)。
 *
 *   POST   console/activation-codes              — 选计划(selection)+ 数量,批量生成
 *   GET    console/activation-codes              — 分页列表(status/batchId/search 过滤)
 *   GET    console/activation-codes/export       — 导出码(纯文本,一行一个;按 status/batchId 过滤)
 *   POST   console/activation-codes/:id/disable  — 停用一张未激活的码
 */
@Controller("console/activation-codes")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class ActivationCodeAdminController {
  constructor(
    private readonly activationCode: ActivationCodeService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Post()
  async generate(@Body() dto: GenerateActivationCodesDto, @Request() req: any) {
    const result = await this.activationCode.generate({
      selection: dto.selection,
      count: dto.count,
      name: dto.name,
      batchId: dto.batchId,
      createdById: req.user?.id,
    });

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GENERATE_ACTIVATION_CODES",
      targetType: "ActivationCode",
      targetId: result.batchId,
      detail: { count: result.count, batchId: result.batchId },
    });

    return result;
  }

  @Get()
  list(
    @Query("status") status?: "UNUSED" | "ACTIVATED" | "DISABLED",
    @Query("batchId") batchId?: string,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.activationCode.list({
      status,
      batchId,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("export")
  async export(
    @Query("status") status?: "UNUSED" | "ACTIVATED" | "DISABLED",
    @Query("batchId") batchId?: string,
  ) {
    // 导出整批(最多 200/页 → 这里取足量;批次通常 ≤ 200)。前端据此生成下载文件。
    const { items } = await this.activationCode.list({ status, batchId, page: 1, pageSize: 200 });
    return { codes: items.map((i) => i.code) };
  }

  @Post(":id/disable")
  async disable(@Param("id") id: string, @Request() req: any) {
    const result = await this.activationCode.disable(id);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "DISABLE_ACTIVATION_CODE",
      targetType: "ActivationCode",
      targetId: id,
    });

    return result;
  }
}
