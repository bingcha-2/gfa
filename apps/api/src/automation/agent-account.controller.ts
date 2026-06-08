/**
 * AgentAccountController — REST API for child/proxy account lifecycle management.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { AgentAccountService } from "./agent-account.service";

@Controller("agent-accounts")
export class AgentAccountController {
  constructor(private readonly agentAccountService: AgentAccountService) {}

  /** List agent accounts with pagination, optionally filtered by status, pool, banned. */
  @Get()
  findAll(
    @Query("status") status?: string,
    @Query("pool") pool?: string,
    @Query("banned") banned?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.agentAccountService.findAll({
      status,
      pool,
      banned,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  /** Get aggregated status counts including pool stats. */
  @Get("stats")
  getStats() {
    return this.agentAccountService.getStats();
  }

  /** Get available mother accounts for "进组" selection. */
  @Get("mother-options")
  getMotherOptions() {
    return this.agentAccountService.getMotherOptions();
  }

  /** Bulk import agent account credentials. */
  @Post("import")
  bulkImport(@Body() body: { lines: string[] }) {
    if (!body.lines || body.lines.length === 0) {
      throw new Error("lines array is required");
    }
    return this.agentAccountService.bulkImport(body.lines);
  }

  /** Batch move from pending to no_ban or ban_risk pool. */
  @Post("batch-upload")
  batchUpload(@Body() body: { ids: string[]; targetPool: "no_ban" | "ban_risk" }) {
    if (!body.ids || body.ids.length === 0) {
      throw new Error("ids array is required");
    }
    return this.agentAccountService.batchMoveToPool(body.ids, body.targetPool);
  }

  /** Update agent account info. */
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body()
    body: {
      loginPassword?: string;
      totpSecret?: string;
      recoveryEmail?: string;
      notes?: string;
    },
  ) {
    return this.agentAccountService.update(id, body);
  }

  /** Delete agent account. */
  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.agentAccountService.delete(id);
  }

  /** Trigger phone-verify for a single agent account. */
  @Post(":id/phone-verify")
  triggerPhoneVerify(@Param("id") id: string) {
    return this.agentAccountService.triggerPhoneVerify(id);
  }

  /** Trigger OAuth for a single agent account. */
  @Post(":id/oauth")
  triggerOAuth(@Param("id") id: string) {
    return this.agentAccountService.triggerOAuth(id);
  }

  /** Trigger accept-invite for a single agent account. */
  @Post(":id/accept-invite")
  triggerAcceptInvite(@Param("id") id: string) {
    return this.agentAccountService.triggerAcceptInvite(id);
  }

  /** Batch action for multiple agent accounts. */
  @Post("batch-action")
  batchAction(
    @Body() body: { ids: string[]; action: "phone-verify" | "oauth" | "accept-invite" },
  ) {
    if (!body.ids || body.ids.length === 0) {
      throw new Error("ids array is required");
    }
    return this.agentAccountService.batchAction(body.ids, body.action);
  }

  /** Extract refresh_token from the last completed task and save to AgentAccount. */
  @Post(":id/extract-token")
  extractToken(@Param("id") id: string) {
    return this.agentAccountService.extractTokenFromTask(id);
  }

  /** Toggle banned status for an uploaded account. */
  @Post(":id/toggle-banned")
  toggleBanned(@Param("id") id: string) {
    return this.agentAccountService.toggleBanned(id);
  }

  /** Replace: swap uploaded child with a new pending child. */
  @Post(":id/replace")
  replaceInPool(
    @Param("id") id: string,
    @Body() body: { newAccountId: string },
  ) {
    return this.agentAccountService.replaceInPool(id, body.newAccountId);
  }

  /** Migrate: move uploaded child to a different mother account. */
  @Post(":id/migrate")
  migrateToMother(
    @Param("id") id: string,
    @Body() body: { newGroupId: string },
  ) {
    return this.agentAccountService.migrateToMother(id, body.newGroupId);
  }

  /** Upload accounts directly to Rosetta account pool (accounts.json). */
  @Post("upload-rosetta")
  uploadToRosetta(@Body() body: { ids: string[] }) {
    if (!body.ids || body.ids.length === 0) {
      throw new Error("ids array is required");
    }
    return this.agentAccountService.uploadToRosetta(body.ids);
  }

  /** Upload accounts to remote CLIProxyAPI via management API. */
  @Post("upload-cliproxy")
  uploadToCliProxy(@Body() body: { ids: string[]; clientId?: string; clientSecret?: string }) {
    if (!body.ids || body.ids.length === 0) {
      throw new Error("ids array is required");
    }
    return this.agentAccountService.uploadToCliProxy(body.ids, body.clientId, body.clientSecret);
  }

  /** Query remote CLIProxyAPI status and loaded credentials. */
  @Get("cliproxy-status")
  getCliProxyStatus() {
    return this.agentAccountService.getCliProxyStatus();
  }
}
