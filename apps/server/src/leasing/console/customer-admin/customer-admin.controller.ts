/**
 * customer-admin.controller.ts — console customer management surface.
 *
 *   GET   console/customers                  — list (page/pageSize/search/status)
 *   GET   console/customers/:id              — detail (+subscriptions/orders/devices)
 *   PATCH console/customers/:id              — enable-disable / edit note / credit
 *
 * Mirrors the console admin-mutation convention (see billing-admin.controller):
 * ConsoleJwtGuard + @Roles("ADMIN","OPERATIONS") at class level, mutations
 * audit-logged with the operator id.
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { AuditLogService } from "../../../shared/audit-log/audit-log.service";
import { CustomerAdminService } from "./customer-admin.service";
import { GrantCatalogSubscriptionDto, UpdateCustomerDto } from "./dto/customer-admin.dto";

@Controller("console/customers")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class CustomerAdminController {
  constructor(
    private readonly customerAdmin: CustomerAdminService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query("search") search?: string,
    @Query("status") status?: string,
  ) {
    return this.customerAdmin.listCustomers({ page, pageSize, search, status });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.customerAdmin.getCustomer(id);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateCustomerDto,
    @Request() req: any,
  ) {
    const result = await this.customerAdmin.updateCustomer(id, dto);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: dto.status === "DISABLED" ? "DISABLE_CUSTOMER" : "UPDATE_CUSTOMER",
      targetType: "Customer",
      targetId: id,
      detail: dto as unknown as Record<string, unknown>,
    });

    return result;
  }

  /** 目录版手动授予订阅(管理员,bypass 支付):提交一个目录 selection。 */
  @Post(":id/subscriptions")
  async grant(
    @Param("id") id: string,
    @Body() dto: GrantCatalogSubscriptionDto,
    @Request() req: any,
  ) {
    const sub = await this.customerAdmin.grantCatalogSubscription(id, dto.selection, {
      durationDays: dto.durationDays,
    });
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GRANT_SUBSCRIPTION",
      targetType: "Customer",
      targetId: id,
      detail: { selection: dto.selection, durationDays: dto.durationDays, subscriptionId: sub.id },
    });
    return sub;
  }
}
