import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { SchedulerService } from "./scheduler.service";
import { Roles } from "../auth/roles.decorator";

@Controller(["scheduler", "console/scheduler"])
@Roles("ADMIN", "OPERATIONS")
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get("config")
  getConfig() {
    return this.scheduler.getConfig();
  }

  @Patch("config")
  updateConfig(@Body() body: Record<string, unknown>) {
    return this.scheduler.updateConfig(body);
  }

  @Post("run")
  @HttpCode(HttpStatus.ACCEPTED)
  async manualRun() {
    return this.scheduler.manualRun();
  }

  @Get("status")
  getStatus() {
    return this.scheduler.getStatus();
  }

  @Get("tasks")
  getTasks(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("search") search?: string,
    @Query("type") type?: string,
    @Query("status") status?: string,
  ) {
    const p = Math.max(1, parseInt(page || "1", 10) || 1);
    const ps = Math.min(100, Math.max(1, parseInt(pageSize || "20", 10) || 20));
    return this.scheduler.getSchedulerTasks(p, ps, {
      search: search?.trim() || undefined,
      type: type?.trim() || undefined,
      status: status?.trim() || undefined,
    });
  }
}
