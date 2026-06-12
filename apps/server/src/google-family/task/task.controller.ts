import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request
} from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";

import { Roles } from "../../shared/auth/roles.decorator";
import { AuditLogService } from "../../shared/audit-log/audit-log.service";
import { TaskService } from "./task.service";

class ManualCompleteDto {
  @IsOptional()
  @IsString()
  resultMessage?: string;
}

class ManualFailDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller("console/tasks")
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  findAll(
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.taskService.findAll({
      status,
      type,
      search,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.taskService.findOne(id);
  }

  @Post(":id/retry")
  @Roles("ADMIN", "OPERATIONS")
  async retry(@Param("id") id: string, @Request() req: any) {
    const task = await this.taskService.retry(id);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "RETRY_TASK",
      targetType: "Task",
      targetId: id
    });

    return task;
  }

  @Post(":id/manual-complete")
  @Roles("ADMIN", "OPERATIONS", "SUPPORT")
  async manualComplete(
    @Param("id") id: string,
    @Body() dto: ManualCompleteDto,
    @Request() req: any
  ) {
    const task = await this.taskService.manualComplete(id, dto.resultMessage);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "MANUAL_COMPLETE_TASK",
      targetType: "Task",
      targetId: id,
      detail: { resultMessage: dto.resultMessage }
    });

    return task;
  }

  @Post(":id/manual-fail")
  @Roles("ADMIN", "OPERATIONS", "SUPPORT")
  async manualFail(
    @Param("id") id: string,
    @Body() dto: ManualFailDto,
    @Request() req: any
  ) {
    const task = await this.taskService.manualFail(id, dto.reason);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "MANUAL_FAIL_TASK",
      targetType: "Task",
      targetId: id,
      detail: { reason: dto.reason }
    });

    return task;
  }

  @Post(":id/cancel")
  @Roles("ADMIN", "OPERATIONS")
  async cancel(
    @Param("id") id: string,
    @Body() dto: ManualFailDto,
    @Request() req: any
  ) {
    const task = await this.taskService.cancel(id, dto.reason);

    await this.auditLog.log({
      operatorId: req.user.id,
      action: "CANCEL_TASK",
      targetType: "Task",
      targetId: id,
      detail: { reason: dto.reason }
    });

    return task;
  }
}
