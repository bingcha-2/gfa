/**
 * account-levels.controller.ts — console「账号池实际等级」只读查询。
 *
 *   GET console/account-levels?product=xxx — 该产品账号池里去重的 planType 列表(空值排除)
 *
 * 供套餐配置页绑定线等级从下拉里选(账号池里没有的等级选不了),使 console 档名 ↔
 * account.planType ↔ 绑定匹配天然一致。对齐 console 管理面约定(见 customer-admin /
 * plan-catalog-admin.controller):ConsoleJwtGuard + @Roles("ADMIN","OPERATIONS") 类级,
 * 操作审计带 operatorId。
 */
import { Controller, Get, Query, Request, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { AuditLogService } from "../../../shared/audit-log/audit-log.service";
import { AccountLevelsService } from "./account-levels.service";

@Controller("console/account-levels")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class AccountLevelsController {
  constructor(
    private readonly accountLevels: AccountLevelsService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  async list(@Query("product") product: string, @Request() req: any) {
    const result = this.accountLevels.listLevels(String(product || ""));

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "READ_ACCOUNT_LEVELS",
      targetType: "AccountPool",
      targetId: String(product || ""),
      detail: { count: result.levels.length },
    });

    return result;
  }
}
