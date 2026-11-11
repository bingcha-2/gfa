/**
 * gateway-pool.controller.ts — console「第三方母号」管理。
 *
 *   GET    console/gateway-accounts            列表(脱敏,不含 key)
 *   POST   console/gateway-accounts            添加母号并向上游开 1 个私有 key
 *   PATCH  console/gateway-accounts/:id        更新母号配置、启用/停用
 *   DELETE console/gateway-accounts/:id        删除本地记录
 *   GET    console/gateway-accounts/settings   上游地址 + 运营 Key 是否已配置(不返回 Key)
 *   PUT    console/gateway-accounts/settings   保存上游地址/运营 Key(Key 留空不修改)
 *   POST   console/gateway-accounts/refresh    手动刷新(与定时任务共用互斥,10 秒内去重)
 *
 * 全部接口都只返回脱敏字段,没有任何"查看 key 明文"的入口。
 * 仅 ADMIN(SUPER_ADMIN 由 RolesGuard 放行),操作写审计日志。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Request, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../shared/auth/console-jwt.guard";
import { Roles } from "../../shared/auth/roles.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { GatewayPoolService } from "./gateway-pool.service";

@Controller("console/gateway-accounts")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN")
export class GatewayPoolController {
  constructor(
    private readonly pool: GatewayPoolService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get("settings")
  getSettings() {
    return this.pool.getSettings();
  }

  @Put("settings")
  async saveSettings(@Body() body: { baseUrl?: string; opKey?: string }, @Request() req: any) {
    const result = await this.pool.saveSettings(body);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GATEWAY_SETTINGS_SAVE",
      targetType: "GatewaySettings",
      targetId: "upstream",
      detail: { baseUrl: result.baseUrl, opKeyChanged: Boolean(body?.opKey), ip: req.ip },
    });
    return result;
  }

  @Get()
  list() {
    return this.pool.list();
  }

  @Post("refresh")
  async refresh(@Request() req: any) {
    const result = await this.pool.refreshAll(true);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GATEWAY_ACCOUNTS_REFRESH",
      targetType: "GatewayMotherAccount",
      targetId: "all",
      detail: { count: result.length, ip: req.ip },
    });
    return result;
  }

  @Post()
  async add(
    @Body() body: { accountName: string; upstreamId?: string; baseUrl?: string; totalShares?: number; opKey?: string },
    @Request() req: any,
  ) {
    const view = await this.pool.add(body?.accountName, body?.upstreamId, body?.baseUrl, body?.totalShares, body?.opKey);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GATEWAY_ACCOUNT_ADD",
      targetType: "GatewayMotherAccount",
      targetId: view.id,
      detail: { accountName: view.accountName, status: view.status, ip: req.ip },
    });
    return view;
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: { enabled?: boolean; baseUrl?: string; totalShares?: number; opKey?: string },
    @Request() req: any,
  ) {
    if (body?.enabled !== undefined) await this.pool.setEnabled(id, Boolean(body.enabled));
    if (body?.baseUrl !== undefined || body?.totalShares !== undefined || body?.opKey !== undefined) {
      await this.pool.setConfig(id, { baseUrl: body.baseUrl, totalShares: body.totalShares, opKey: body.opKey });
    }
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GATEWAY_ACCOUNT_UPDATE",
      targetType: "GatewayMotherAccount",
      targetId: id,
      detail: { enabled: body?.enabled, baseUrl: body?.baseUrl, totalShares: body?.totalShares, opKeyChanged: Boolean(String(body?.opKey ?? "").trim()), ip: req.ip },
    });
    return (await this.pool.list()).find((x: any) => x.id === id);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Request() req: any) {
    await this.pool.remove(id);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "GATEWAY_ACCOUNT_REMOVE",
      targetType: "GatewayMotherAccount",
      targetId: id,
      detail: { ip: req.ip },
    });
    return { ok: true };
  }
}
