import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request
} from "@nestjs/common";
import { IsEmail, IsInt, IsOptional, IsString, IsDateString } from "class-validator";

import { Roles } from "../auth/roles.decorator";
import { AuditLogService } from "../audit-log/audit-log.service";
import { FamilyGroupService } from "./family-group.service";
import { BulkRemoveDto } from "./dto/bulk-remove.dto";
import { BulkInviteDto } from "./dto/bulk-invite.dto";
import { CrossBulkRemoveDto } from "./dto/cross-bulk-remove.dto";
import { CrossBulkInviteDto } from "./dto/cross-bulk-invite.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";

class CreateFamilyGroupDto {
  @IsString()
  accountId!: string;

  @IsString()
  groupName!: string;

  @IsOptional()
  @IsInt()
  maxMembers?: number;
}

class RemoveMemberDto {
  @IsEmail()
  memberEmail!: string;
}

class UpdateMemberDatesDto {
  @IsOptional()
  @IsDateString()
  joinedAt?: string | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

class ReplaceMemberDto {
  @IsEmail()
  targetMemberEmail!: string;

  @IsEmail()
  newUserEmail!: string;
}

@Controller("family-groups")
export class FamilyGroupController {
  constructor(
    private readonly familyGroupService: FamilyGroupService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  @Roles("ADMIN", "OPERATIONS")
  findAll(
    @Query("accountId") accountId?: string,
    @Query("memberEmail") memberEmail?: string,
  ) {
    return this.familyGroupService.findAll({ accountId, memberEmail });
  }

  /**
   * Cross-group bulk remove — static path MUST come before /:id to avoid being
   * matched as a group ID by NestJS router.
   */
  @Post("cross-remove")
  @Roles("ADMIN", "OPERATIONS")
  async crossBulkRemove(@Body() dto: CrossBulkRemoveDto, @Request() req: any) {
    const result = await this.familyGroupService.crossBulkRemove(dto.memberEmails);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CROSS_BULK_REMOVE",
      targetType: "FamilyGroup",
      targetId: "*",
      detail: {
        queued: result.queued.length,
        notFound: result.notFound.length,
        alreadyRemoved: result.alreadyRemoved.length,
        failed: result.failed.length
      }
    });

    return result;
  }

  @Post("cross-invite")
  @Roles("ADMIN", "OPERATIONS")
  async crossBulkInvite(@Body() dto: CrossBulkInviteDto, @Request() req: any) {
    const result = await this.familyGroupService.crossBulkInvite(dto.emails, dto.validDays);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CROSS_BULK_INVITE",
      targetType: "FamilyGroup",
      targetId: "*",
      detail: {
        totalQueued: result.allocated.reduce((s, a) => s + a.queued.length, 0),
        groups: result.allocated.length,
        unplaceable: result.unplaceable.length,
        alreadyActive: result.alreadyActive.length
      }
    });

    return result;
  }

  @Get("expired-members")
  @Roles("ADMIN", "OPERATIONS")
  getExpiredMembers(
    @Query("status") status?: string,
    @Query("email") email?: string,
    @Query("groupId") groupId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const parsedPage = page ? parseInt(page, 10) : undefined;
    const parsedSize = pageSize ? parseInt(pageSize, 10) : undefined;
    return this.familyGroupService.getExpiredMembers({
      status: status as any,
      email,
      groupId,
      page: Number.isNaN(parsedPage) ? undefined : parsedPage,
      pageSize: Number.isNaN(parsedSize) ? undefined : parsedSize,
    });
  }

  @Post("bulk-remove-expired")
  @Roles("ADMIN", "OPERATIONS")
  async bulkRemoveExpired(@Request() req: any) {
    const result = await this.familyGroupService.bulkRemoveExpired();

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BULK_REMOVE_EXPIRED",
      targetType: "FamilyMember",
      targetId: "*",
      detail: {
        totalExpired: result.totalExpired,
        queued: result.queued.length,
        failed: result.failed.length
      }
    });

    return result;
  }

  @Get("lookup-by-member")
  @Roles("ADMIN", "OPERATIONS", "SUPPORT")
  lookupByMember(@Query("email") email: string) {
    if (!email || !email.includes("@")) {
      return { found: false, error: "Please provide a valid email address" };
    }
    return this.familyGroupService.lookupByMemberEmail(email);
  }

  @Get("search-members")
  @Roles("ADMIN", "OPERATIONS")
  searchMembers(
    @Query("email") email: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    if (!email || email.trim().length < 2) {
      return { members: [], total: 0, page: 1, pageSize: 50 };
    }
    const parsedPage = page ? parseInt(page, 10) : undefined;
    const parsedSize = pageSize ? parseInt(pageSize, 10) : undefined;
    return this.familyGroupService.searchByMemberEmail(email, {
      page: Number.isNaN(parsedPage) ? undefined : parsedPage,
      pageSize: Number.isNaN(parsedSize) ? undefined : parsedSize,
    });
  }

  // ========== Transfer ==========
  // Static paths MUST come before /:id to avoid being matched as a group ID

  @Post("transfer")
  @Roles("ADMIN", "OPERATIONS")
  async createTransfer(@Body() dto: CreateTransferDto, @Request() req: any) {
    const result = await this.familyGroupService.createTransfer(dto);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CREATE_TRANSFER",
      targetType: "TransferBatch",
      targetId: result.batchId,
      detail: {
        sourceGroupId: dto.sourceGroupId,
        targetGroupId: dto.targetGroupId,
        totalMembers: result.totalMembers,
        memberEmails: result.memberEmails,
      }
    });

    return result;
  }

  @Get("transfer")
  @Roles("ADMIN", "OPERATIONS")
  listTransfers() {
    return this.familyGroupService.listTransfers();
  }

  @Get("transfer/:batchId")
  @Roles("ADMIN", "OPERATIONS")
  getTransferStatus(@Param("batchId") batchId: string) {
    return this.familyGroupService.getTransferStatus(batchId);
  }

  @Get(":id")
  @Roles("ADMIN", "OPERATIONS")
  findOne(@Param("id") id: string) {
    return this.familyGroupService.findOne(id);
  }


  @Get(":id/members")
  @Roles("ADMIN", "OPERATIONS")
  getMembers(@Param("id") id: string) {
    return this.familyGroupService.getMembers(id);
  }

  @Post()
  @Roles("ADMIN")
  async create(@Body() dto: CreateFamilyGroupDto, @Request() req: any) {
    const group = await this.familyGroupService.create(dto);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CREATE_FAMILY_GROUP",
      targetType: "FamilyGroup",
      targetId: group.id,
      detail: { groupName: dto.groupName, accountId: dto.accountId }
    });

    return group;
  }

  @Post(":id/remove-member")
  @Roles("ADMIN", "OPERATIONS")
  async removeMember(
    @Param("id") id: string,
    @Body() dto: RemoveMemberDto,
    @Request() req: any
  ) {
    const result = await this.familyGroupService.removeMember(
      id,
      dto.memberEmail
    );

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "REMOVE_MEMBER",
      targetType: "FamilyGroup",
      targetId: id,
      detail: { memberEmail: dto.memberEmail }
    });

    return result;
  }

  @Post(":id/replace-member")
  @Roles("ADMIN", "OPERATIONS")
  async replaceMember(
    @Param("id") id: string,
    @Body() dto: ReplaceMemberDto,
    @Request() req: any
  ) {
    const result = await this.familyGroupService.replaceMember(
      id,
      dto.targetMemberEmail,
      dto.newUserEmail
    );

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "REPLACE_MEMBER",
      targetType: "FamilyGroup",
      targetId: id,
      detail: {
        targetMemberEmail: dto.targetMemberEmail,
        newUserEmail: dto.newUserEmail
      }
    });

    return result;
  }

  @Post(":id/sync")
  @Roles("ADMIN", "OPERATIONS")
  async sync(@Param("id") id: string, @Request() req: any) {
    const result = await this.familyGroupService.triggerSync(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "TRIGGER_SYNC",
      targetType: "FamilyGroup",
      targetId: id
    });

    return result;
  }

  @Post(":id/bulk-remove")
  @Roles("ADMIN", "OPERATIONS")
  async bulkRemove(
    @Param("id") id: string,
    @Body() dto: BulkRemoveDto,
    @Request() req: any
  ) {
    const result = await this.familyGroupService.bulkRemove(id, dto.memberEmails);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BULK_REMOVE",
      targetType: "FamilyGroup",
      targetId: id,
      detail: {
        queued: result.queued.length,
        notFound: result.notFound.length,
        alreadyRemoved: result.alreadyRemoved.length,
        failed: result.failed.length
      }
    });

    return result;
  }

  @Post(":id/bulk-invite")
  @Roles("ADMIN", "OPERATIONS")
  async bulkInvite(
    @Param("id") id: string,
    @Body() dto: BulkInviteDto,
    @Request() req: any
  ) {
    const result = await this.familyGroupService.bulkInvite(id, dto.emails, dto.validDays);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "BULK_INVITE",
      targetType: "FamilyGroup",
      targetId: id,
      detail: {
        queued: result.queued.length,
        rejected: result.rejected.length,
        reason: result.reason
      }
    });

    return result;
  }

  @Post(":id/toggle-auto-assign")
  @Roles("ADMIN", "OPERATIONS")
  async toggleAutoAssign(@Param("id") id: string, @Request() req: any) {
    const result = await this.familyGroupService.toggleAutoAssign(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "TOGGLE_AUTO_ASSIGN",
      targetType: "FamilyGroup",
      targetId: id,
      detail: { newStatus: result.status }
    });

    return result;
  }

  @Get(":id/tasks")
  @Roles("ADMIN", "OPERATIONS")
  getTasks(
    @Param("id") id: string,
    @Query("type") type?: string,
    @Query("since") since?: string
  ) {
    return this.familyGroupService.getTasks(id, { type, since });
  }

  @Patch(":id/members/:memberId/dates")
  @Roles("ADMIN", "OPERATIONS")
  async updateMemberDates(
    @Param("id") groupId: string,
    @Param("memberId") memberId: string,
    @Body() dto: UpdateMemberDatesDto,
    @Request() req: any
  ) {
    const result = await this.familyGroupService.updateMemberDates(groupId, memberId, dto);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "UPDATE_MEMBER_DATES",
      targetType: "FamilyMember",
      targetId: memberId,
      detail: { groupId, joinedAt: dto.joinedAt, expiresAt: dto.expiresAt }
    });

    return result;
  }
}
