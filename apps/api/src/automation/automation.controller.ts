/**
 * AutomationController — endpoints for browser automation tasks.
 *
 * Public endpoints — called by the Tauri desktop client.
 * Console endpoints — called by the web console (auth required).
 */

import { Body, Controller, Delete, Get, Param, Post, Query, Logger } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { AutomationService } from "./automation.service";
import { StartAutomationDto, BatchOAuthDto, ConsoleStartDto, RepairAutomationDto } from "./dto/automation.dto";

@Controller("automation")
export class AutomationController {
  private readonly logger = new Logger(AutomationController.name);

  constructor(
    private readonly automationService: AutomationService,
  ) {}

  // ── Public endpoints (called by GFA Client) ──

  /**
   * Start a single automation task.
   * POST /api/automation/start
   * Body: { action, email, password, recoveryEmail?, totpSecret? }
   */
  @Post("start")
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 500 } })
  async start(@Body() dto: StartAutomationDto) {
    return this.automationService.startAutomation(dto.action, {
      email: dto.email,
      password: dto.password,
      recoveryEmail: dto.recoveryEmail,
      totpSecret: dto.totpSecret
    }, dto.phones?.map(p => ({
      phoneNumber: p.phoneNumber,
      countryCode: p.countryCode ?? "+1",
      smsUrl: p.smsUrl,
    })), dto.childEmail ? {
      email: dto.childEmail,
      password: dto.childPassword ?? "",
      recoveryEmail: dto.childRecoveryEmail,
      totpSecret: dto.childTotpSecret,
    } : undefined, {
      profileId: dto.profileId,
      keepBrowserOpenOnChallenge: dto.keepBrowserOpenOnChallenge,
      source: dto.source,
    });
  }

  /**
   * Start account repair using credentials already stored by Rosetta.
   * POST /api/automation/repair
   * Body: { email?, accountId?, profileId?, keepBrowserOpenOnChallenge? }
   */
  @Post("repair")
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 300 } })
  async repair(@Body() dto: RepairAutomationDto) {
    return this.automationService.repairFromStoredCredentials(dto);
  }

  /**
   * Batch OAuth authorization for multiple accounts.
   * POST /api/automation/batch-oauth
   * Body: { accounts: [{ email, password, recoveryEmail?, totpSecret? }] }
   */
  @Post("batch-oauth")
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 500 } })
  async batchOAuth(@Body() dto: BatchOAuthDto) {
    return this.automationService.batchOAuth(dto.accounts);
  }

  /**
   * Poll task status (used by client for progress updates).
   * GET /api/automation/status/:taskId
   */
  @Get("status/:taskId")
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5000 } })
  async getStatus(@Param("taskId") taskId: string) {
    return this.automationService.getTaskStatus(taskId);
  }

  // ── Console endpoints (auth required) ──

  /**
   * Start an automation task from the web console.
   * Uses account credentials from the database (not from client).
   * POST /api/automation/console-start
   * Body: { accountId, action }
   */
  @Post("console-start")
  @Throttle({ default: { ttl: 60000, limit: 100 } })
  async consoleStart(@Body() dto: ConsoleStartDto) {
    return this.automationService.consoleStart(dto.accountId, dto.action);
  }

  /**
   * List all phone pool entries (for console phone pool tab).
   * GET /api/automation/phone-pool
   */
  @Get("phone-pool")
  @Public()
  async listPhones() {
    return this.automationService.listPhonePool();
  }

  /**
   * Import phones to pool (console).
   * POST /api/automation/phone-pool/import
   */
  @Post("phone-pool/import")
  async importPhones(@Body() body: { lines: string[]; source?: string }) {
    return this.automationService.importPhones(body.lines, body.source);
  }

  /**
   * Toggle phone status.
   * POST /api/automation/phone-pool/:id/toggle
   */
  @Post("phone-pool/:id/toggle")
  async togglePhone(@Param("id") id: string) {
    return this.automationService.togglePhone(id);
  }

  /**
   * Delete phone from pool.
   * POST /api/automation/phone-pool/:id/delete
   */
  @Post("phone-pool/:id/delete")
  async deletePhone(@Param("id") id: string) {
    return this.automationService.deletePhoneFromPool(id);
  }

  /**
   * Get daily records of recently-added family members.
   * GET /api/automation/daily-records?days=7
   */
  @Get("daily-records")
  async getDailyRecords(@Query("days") days?: string) {
    const numDays = days ? parseInt(days, 10) : 7;
    return this.automationService.getDailyRecords(
      Number.isFinite(numDays) && numDays > 0 ? numDays : 7
    );
  }

  // ── Account Token Management (母号 Refresh Token) ──

  /**
   * List parent accounts with their token extraction status.
   * GET /api/automation/account-tokens?page=1&pageSize=20
   */
  @Get("account-tokens")
  async listAccountTokens(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const p = page ? parseInt(page, 10) : 1;
    const ps = pageSize ? parseInt(pageSize, 10) : 20;
    return this.automationService.listAccountTokens(
      Number.isFinite(p) && p > 0 ? p : 1,
      Number.isFinite(ps) && ps > 0 ? Math.min(ps, 100) : 20,
    );
  }

  /**
   * Trigger phone verification for a parent account to extract token.
   * POST /api/automation/account-token/trigger-verify/:id
   */
  @Post("account-token/trigger-verify/:id")
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async triggerAccountVerify(@Param("id") id: string) {
    return this.automationService.triggerAccountPhoneVerify(id);
  }

  /**
   * Batch trigger phone verification for multiple parent accounts.
   * POST /api/automation/account-token/batch-verify
   * Body: { accountIds: string[] }
   */
  @Post("account-token/batch-verify")
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async batchTriggerAccountVerify(@Body() body: { accountIds: string[] }) {
    if (!body.accountIds || body.accountIds.length === 0) {
      throw new Error("accountIds array is required");
    }
    return this.automationService.batchTriggerAccountPhoneVerify(body.accountIds);
  }

  /**
   * Extract refresh_token from a completed task into the Account record.
   * POST /api/automation/account-token/extract/:taskId
   */
  @Post("account-token/extract/:taskId")
  async extractAccountToken(@Param("taskId") taskId: string) {
    return this.automationService.extractAccountToken(taskId);
  }

  /**
   * Mark account token as used or unused.
   * POST /api/automation/account-token/:id/status
   * Body: { status: "used" | "unused" }
   */
  @Post("account-token/:id/status")
  async updateAccountTokenStatus(
    @Param("id") id: string,
    @Body() body: { status: "used" | "unused" }
  ) {
    if (!body.status || !["used", "unused"].includes(body.status)) {
      throw new Error("status must be 'used' or 'unused'");
    }
    return this.automationService.updateAccountTokenStatus(id, body.status);
  }

  /**
   * Delete an account's refresh token.
   * DELETE /api/automation/account-token/:id
   */
  @Delete("account-token/:id")
  async deleteAccountToken(@Param("id") id: string) {
    return this.automationService.deleteAccountToken(id);
  }
}

