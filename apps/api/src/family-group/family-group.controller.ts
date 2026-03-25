import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request
} from "@nestjs/common";
import { IsInt, IsOptional, IsString } from "class-validator";

import { Roles } from "../auth/roles.decorator";
import { AuditLogService } from "../audit-log/audit-log.service";
import { FamilyGroupService } from "./family-group.service";

class CreateFamilyGroupDto {
  @IsString()
  accountId!: string;

  @IsString()
  groupName!: string;

  @IsOptional()
  @IsInt()
  maxMembers?: number;
}

@Controller("family-groups")
export class FamilyGroupController {
  constructor(
    private readonly familyGroupService: FamilyGroupService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  findAll(@Query("accountId") accountId?: string) {
    return this.familyGroupService.findAll(accountId);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.familyGroupService.findOne(id);
  }

  @Get(":id/members")
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

  @Post(":id/sync")
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
}
