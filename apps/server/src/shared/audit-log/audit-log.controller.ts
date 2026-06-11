import { Controller, Get, Query } from "@nestjs/common";

import { Roles } from "../auth/roles.decorator";
import { AuditLogService } from "./audit-log.service";

@Controller(["audit-logs", "console/audit-logs"])
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @Roles("ADMIN")
  findAll(
    @Query("operatorId") operatorId?: string,
    @Query("targetType") targetType?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string
  ) {
    return this.auditLogService.findAll({
      operatorId,
      targetType,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined
    });
  }
}
