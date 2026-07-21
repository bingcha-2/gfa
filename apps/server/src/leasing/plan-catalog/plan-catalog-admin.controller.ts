import { Body, Controller, Get, Param, Patch, Post, Request, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../shared/auth/console-jwt.guard";
import { Roles } from "../../shared/auth/roles.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { CreatePlanCatalogDraftDto } from "./dto/create-plan-catalog-draft.dto";

/**
 * Console plan-catalog management (spec §7.1) — create draft / publish.
 * ConsoleJwtGuard + ADMIN|OPERATIONS at class level, every mutation audit-logged
 * with the operator id (mirrors PlanAdminController / BillingAdminController).
 *
 *   POST console/plan-catalog            — create a DRAFT version from a config object
 *   POST console/plan-catalog/:id/publish — publish a version (prior PUBLISHED → ARCHIVED)
 */
@Controller("console/plan-catalog")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class PlanCatalogAdminController {
  constructor(
    private readonly planCatalog: PlanCatalogService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get("codex-relay")
  async getCodexRelaySettings() {
    return this.planCatalog.getCodexRelaySettings();
  }

  @Patch("codex-relay")
  async updateCodexRelaySettings(@Body() body: any, @Request() req: any) {
    const settings = await this.planCatalog.updateCodexRelaySettings(body || {});
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "UPDATE_CODEX_RELAY_SETTINGS",
      targetType: "SiteSetting",
      targetId: "codex-relay",
      // Never include the API key (or its submitted body) in audit detail.
      detail: { enabled: settings.enabled, baseUrl: settings.baseUrl, models: settings.models },
    });
    return settings;
  }

  @Post()
  async createDraft(@Body() dto: CreatePlanCatalogDraftDto, @Request() req: any) {
    const draft = await this.planCatalog.createDraft(JSON.stringify(dto.config));

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "CREATE_PLAN_CATALOG",
      targetType: "PlanCatalog",
      targetId: draft.id,
      detail: { version: draft.version },
    });

    return draft;
  }

  @Post(":id/publish")
  async publish(@Param("id") id: string, @Request() req: any) {
    const published = await this.planCatalog.publish(id);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "PUBLISH_PLAN_CATALOG",
      targetType: "PlanCatalog",
      targetId: id,
      detail: { version: published.version },
    });

    return published;
  }
}
