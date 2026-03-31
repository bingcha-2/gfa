/**
 * AutomationController — Public endpoints for browser automation tasks.
 *
 * These are @Public() because gfa-client calls them without JWT auth
 * (same as redeem/swap endpoints). Credentials are passed in each request
 * from the client's local SQLite.
 */

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { AutomationService } from "./automation.service";
import { StartAutomationDto, BatchOAuthDto } from "./dto/automation.dto";

@Controller("automation")
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  /**
   * Start a single automation task.
   * POST /api/automation/start
   * Body: { action, email, password, recoveryEmail?, totpSecret? }
   */
  @Post("start")
  @Public()
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
  @Public()
  async batchOAuth(@Body() dto: BatchOAuthDto) {
    return this.automationService.batchOAuth(dto.accounts);
  }

  /**
   * Poll task status (used by client for progress updates).
   * GET /api/automation/status/:taskId
   */
  @Get("status/:taskId")
  @Public()
  async getStatus(@Param("taskId") taskId: string) {
    return this.automationService.getTaskStatus(taskId);
  }
}
