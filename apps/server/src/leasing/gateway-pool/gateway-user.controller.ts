/**
 * gateway-user.controller.ts — 网关用户。
 *
 * 后台(仅 ADMIN,SUPER_ADMIN 由 RolesGuard 放行):
 *   GET    console/gateway-users                 用户列表(份数、额度、已用、剩余)
 *   POST   console/gateway-users                 按邮箱分配份额并生成专用 key
 *   PATCH  console/gateway-users/:id             改份数 / 启用停用
 *   POST   console/gateway-users/:id/reset       清零本周期用量
 *   POST   console/gateway-users/:id/rotate-key  换 key(旧 key 立即失效)
 *   DELETE console/gateway-users/:id             删除
 *   GET/PUT console/gateway-users/settings       每份美元额度、默认用户份数、默认母号份数
 *
 * 客户端:
 *   POST app/gateway/activate  本人激活「一键托管」,返回专用 key、母号 id、模型、额度
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Request, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../shared/auth/console-jwt.guard";
import { Roles } from "../../shared/auth/roles.decorator";
import { Public } from "../../shared/auth/public.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { CustomerJwtGuard } from "../account/customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../account/customer-auth/customer.decorator";
import type { CustomerUser } from "../account/customer-auth/customer-jwt.strategy";
import { GatewayUserService } from "./gateway-user.service";

@Controller("console/gateway-users")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN")
export class GatewayUserAdminController {
  constructor(
    private readonly users: GatewayUserService,
    private readonly auditLog: AuditLogService,
  ) {}

  private audit(req: any, action: string, targetId: string, detail: Record<string, unknown> = {}) {
    return this.auditLog.log({
      operatorId: req.user?.id,
      action,
      targetType: "GatewayUser",
      targetId,
      detail: { ...detail, ip: req.ip },
    });
  }

  @Get("settings")
  getSettings() {
    return this.users.getPoolSettings();
  }

  @Put("settings")
  async saveSettings(
    @Body() body: { shareUsd?: number; defaultUserShares?: number; defaultTotalShares?: number },
    @Request() req: any,
  ) {
    const r = await this.users.savePoolSettings(body || {});
    await this.audit(req, "GATEWAY_POOL_SETTINGS_SAVE", "settings", { ...body });
    return r;
  }

  @Get()
  list() {
    return this.users.listUsers();
  }

  @Post()
  async assign(@Body() body: { email: string; shares?: number; motherAccountId?: string }, @Request() req: any) {
    const r = await this.users.assign(body?.email, body?.shares, body?.motherAccountId);
    await this.audit(req, "GATEWAY_USER_ASSIGN", r.id, { email: body?.email, shares: r.shares, mother: r.motherAccountName });
    return r;
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: { shares?: number; enabled?: boolean }, @Request() req: any) {
    await this.users.updateUser(id, body || {});
    await this.audit(req, "GATEWAY_USER_UPDATE", id, { ...body });
    return { ok: true };
  }

  @Post(":id/reset")
  async reset(@Param("id") id: string, @Request() req: any) {
    await this.users.resetUsage(id);
    await this.audit(req, "GATEWAY_USER_RESET", id);
    return { ok: true };
  }

  @Post(":id/rotate-key")
  async rotate(@Param("id") id: string, @Request() req: any) {
    await this.users.rotateKey(id);
    await this.audit(req, "GATEWAY_USER_ROTATE_KEY", id);
    return { ok: true };
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Request() req: any) {
    await this.users.removeUser(id);
    await this.audit(req, "GATEWAY_USER_REMOVE", id);
    return { ok: true };
  }
}

@Controller("app/gateway")
export class GatewayClientController {
  constructor(private readonly users: GatewayUserService) {}

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("activate")
  @HttpCode(200)
  activate(@CurrentCustomer() customer: CustomerUser) {
    return this.users.activate(customer.customerId);
  }
}
