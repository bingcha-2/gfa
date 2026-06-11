import { Controller, Get, Post, Body } from "@nestjs/common";

import { Roles } from "../../shared/auth/roles.decorator";
import { ExpireScanService, INTERVAL_OPTIONS } from "./expire-scan.service";

@Controller(["admin/expire-scan", "console/expire-scan"])
@Roles("ADMIN", "OPERATIONS")
export class ExpireScanController {
  constructor(private readonly expireScanService: ExpireScanService) {}

  /** GET /admin/expire-scan/status — pending count + last run info */
  @Get("status")
  getStatus() {
    return this.expireScanService.getStatus();
  }

  /** GET /admin/expire-scan/expired-members — list all members whose expiresAt has passed */
  @Get("expired-members")
  getExpiredMembers() {
    return this.expireScanService.getExpiredMembers();
  }

  /** POST /admin/expire-scan/run — manually trigger a scan immediately */
  @Post("run")
  async runScan() {
    const processed = await this.expireScanService.scanExpiredOrders();
    return {
      triggered: true,
      processedCount: processed.length,
      orders: processed
    };
  }

  /** GET /admin/expire-scan/config — current scan config */
  @Get("config")
  getConfig() {
    return {
      ...this.expireScanService.getConfig(),
      options: INTERVAL_OPTIONS,
    };
  }

  /** POST /admin/expire-scan/config — update scan config */
  @Post("config")
  setConfig(@Body() body: { intervalMinutes: number }) {
    const updated = this.expireScanService.setConfig({
      intervalMinutes: body.intervalMinutes,
    });
    return {
      ...updated,
      options: INTERVAL_OPTIONS,
    };
  }
}
