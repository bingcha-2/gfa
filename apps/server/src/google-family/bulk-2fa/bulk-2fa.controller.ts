import { Controller, Post, Get, Param, Body, Res, Query } from "@nestjs/common";
import { Bulk2faService } from "./bulk-2fa.service";
import { Roles } from "../../shared/auth/roles.decorator";

@Controller(["bulk-2fa", "console/bulk-2fa"])
export class Bulk2faController {
  constructor(private readonly service: Bulk2faService) {}

  @Post("jobs")
  @Roles("ADMIN", "OPERATIONS")
  async createJob(@Body("text") text: string) {
    return this.service.createJob(text);
  }

  @Get("jobs")
  @Roles("ADMIN", "OPERATIONS")
  async listJobs() {
    return this.service.listJobs();
  }

  @Get("jobs/:id")
  @Roles("ADMIN", "OPERATIONS")
  async getJob(@Param("id") id: string) {
    return this.service.getJob(id);
  }

  @Get("jobs/:id/download")
  @Roles("ADMIN", "OPERATIONS")
  async downloadJob(
    @Param("id") id: string,
    @Query("type") type: "success" | "failed",
    @Res() res: any
  ) {
    const data = await this.service.getDownloadData(id, type);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="2fa_${type}_${id}.txt"`);
    return res.send(data);
  }
}
