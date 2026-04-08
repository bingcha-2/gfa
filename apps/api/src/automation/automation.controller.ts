/**
 * AutomationController — API-key protected endpoints for browser automation tasks.
 *
 * Protected by ApiKeyGuard — requires `X-Api-Key` header matching
 * the AUTOMATION_API_KEY env variable. Rate-limited to prevent abuse.
 */

import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { ApiKeyGuard } from "../auth/api-key.guard";
import { AutomationService } from "./automation.service";
import { StartAutomationDto, BatchOAuthDto } from "./dto/automation.dto";

@Controller("automation")
@Public()          // Skip JWT auth (these endpoints use API key instead)
@UseGuards(ApiKeyGuard)  // Require X-Api-Key header
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  /**
   * Start a single automation task.
   * POST /api/automation/start
   * Headers: X-Api-Key: <AUTOMATION_API_KEY>
   * Body: { action, email, password, recoveryEmail?, totpSecret? }
   */
  @Post("start")
  @Throttle({ default: { ttl: 60000, limit: 10 } })
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
   * Headers: X-Api-Key: <AUTOMATION_API_KEY>
   * Body: { accounts: [{ email, password, recoveryEmail?, totpSecret? }] }
   */
  @Post("batch-oauth")
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async batchOAuth(@Body() dto: BatchOAuthDto) {
    return this.automationService.batchOAuth(dto.accounts);
  }

  /**
   * Poll task status (used by client for progress updates).
   * GET /api/automation/status/:taskId
   * Headers: X-Api-Key: <AUTOMATION_API_KEY>
   */
  @Get("status/:taskId")
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async getStatus(@Param("taskId") taskId: string) {
    return this.automationService.getTaskStatus(taskId);
  }
}
