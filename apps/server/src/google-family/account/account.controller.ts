import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request
} from "@nestjs/common";

import { Roles } from "../../shared/auth/roles.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { AccountService } from "./account.service";
import { CreateAccountDto, UpdateAccountDto, BulkImportDto } from "./dto/account.dto";

@Controller("console/accounts")
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  @Roles("ADMIN", "OPERATIONS")
  findAll(@Query("status") status?: string) {
    return this.accountService.findAll(status);
  }

  @Get(":id")
  @Roles("ADMIN", "OPERATIONS")
  findOne(@Param("id") id: string) {
    return this.accountService.findOne(id);
  }

  @Post()
  @Roles("ADMIN")
  async create(@Body() dto: CreateAccountDto, @Request() req: any) {
    const account = await this.accountService.create(dto);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CREATE_ACCOUNT",
      targetType: "Account",
      targetId: account.id,
      detail: { name: dto.name, loginEmail: dto.loginEmail }
    });

    return account;
  }

  @Post("bulk-import")
  @Roles("ADMIN")
  async bulkImport(@Body() dto: BulkImportDto, @Request() req: any) {
    const result = await this.accountService.bulkImport(dto);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BULK_IMPORT_ACCOUNTS",
      targetType: "Account",
      targetId: "bulk",
      detail: {
        total: result.total,
        created: result.created,
        skipped: result.skipped,
        errorCount: result.errorCount
      }
    });

    return result;
  }

  @Patch(":id")
  @Roles("ADMIN")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateAccountDto,
    @Request() req: any
  ) {
    const account = await this.accountService.update(id, dto);

    // Strip sensitive fields from audit log — only record which fields changed
    const { loginPassword, totpSecret, ...safeFields } = dto;
    const detail: Record<string, unknown> = { ...safeFields };
    if (loginPassword !== undefined) detail.loginPasswordChanged = true;
    if (totpSecret !== undefined) detail.totpSecretChanged = true;

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "UPDATE_ACCOUNT",
      targetType: "Account",
      targetId: id,
      detail
    });

    return account;
  }

  @Post(":id/confirm-login")
  @Roles("ADMIN")
  async confirmLogin(@Param("id") id: string, @Request() req: any) {
    const result = await this.accountService.confirmLogin(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CONFIRM_LOGIN",
      targetType: "Account",
      targetId: id,
      detail: { previousStatus: result.previousStatus, tasksRequeued: result.tasksRequeued }
    });

    return result;
  }

  @Post(":id/sync")
  @Roles("ADMIN")
  async syncAccountGroups(@Param("id") id: string, @Request() req: any) {
    const result = await this.accountService.syncAccountGroups(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "SYNC_ACCOUNT_GROUPS",
      targetType: "Account",
      targetId: id,
      detail: { groupsSynced: result.groupsSynced }
    });

    return result;
  }

  @Delete(":id")
  @Roles("ADMIN")
  async remove(@Param("id") id: string, @Request() req: any) {
    const result = await this.accountService.delete(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "DELETE_ACCOUNT",
      targetType: "Account",
      targetId: id,
      detail: { loginEmail: result.loginEmail }
    });

    return result;
  }
}
