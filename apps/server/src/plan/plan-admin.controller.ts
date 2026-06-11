import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";

import { ConsoleJwtGuard } from "../console/console-jwt.guard";
import { Roles } from "../auth/roles.decorator";
import { AuditLogService } from "../audit-log/audit-log.service";
import { PlanService } from "./plan.service";
import { CreatePlanDto, UpdatePlanDto } from "./dto/plan.dto";

/**
 * Console plan CRUD — requires admin JWT + ADMIN or OPERATIONS role.
 * ConsoleJwtGuard is applied at class level (first console controller to do so).
 */
@Controller("console/plans")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class PlanAdminController {
  constructor(
    private readonly planService: PlanService,
    private readonly auditLog: AuditLogService
  ) {}

  @Get()
  findAll() {
    return this.planService.listAll();
  }

  @Post()
  async create(@Body() dto: CreatePlanDto, @Request() req: any) {
    const plan = await this.planService.create(dto);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "CREATE_PLAN",
      targetType: "Plan",
      targetId: plan.id,
      detail: { name: dto.name, priceCents: dto.priceCents, products: dto.products },
    });

    return plan;
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdatePlanDto,
    @Request() req: any
  ) {
    const plan = await this.planService.update(id, dto);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "UPDATE_PLAN",
      targetType: "Plan",
      targetId: id,
      detail: dto as unknown as Record<string, unknown>,
    });

    return plan;
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Request() req: any) {
    const result = await this.planService.delete(id);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "DELETE_PLAN",
      targetType: "Plan",
      targetId: id,
    });

    return result;
  }
}
