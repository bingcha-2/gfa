/**
 * AutomationController — public endpoints for browser automation tasks.
 *
 * These endpoints are called by the Tauri desktop client.
 * Protected by rate limiting. No auth required (same as redeem/order endpoints).
 */

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { AutomationService } from "./automation.service";
import { StartAutomationDto, BatchOAuthDto } from "./dto/automation.dto";

@Controller("automation")
@Public()
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  /**
   * Start a single automation task.
   * POST /api/automation/start
   * Body: { action, email, password, recoveryEmail?, totpSecret? }
   */
  @Post("start")
  @Throttle({ default: { ttl: 60000, limit: 500 } })
  async start(@Body() dto: StartAutomationDto) {
    return this.automationService.startAutomation(dto.action, {
      email: dto.email,
      password: dto.password,
      recoveryEmail: dto.recoveryEmail,
      totpSecret: dto.totpSecret
    });
  }

  /**
   * Batch OAuth authorization for multiple accounts.
   * POST /api/automation/batch-oauth
   * Body: { accounts: [{ email, password, recoveryEmail?, totpSecret? }] }
   */
  @Post("batch-oauth")
  @Throttle({ default: { ttl: 60000, limit: 500 } })
  async batchOAuth(@Body() dto: BatchOAuthDto) {
    return this.automationService.batchOAuth(dto.accounts);
  }

  /**
   * Poll task status (used by client for progress updates).
   * GET /api/automation/status/:taskId
   */
  @Get("status/:taskId")
  @Throttle({ default: { ttl: 60000, limit: 5000 } })
  async getStatus(@Param("taskId") taskId: string) {
    return this.automationService.getTaskStatus(taskId);
  }
}
