import { Controller, Get, Post } from "@nestjs/common";

import { Roles } from "../auth/roles.decorator";
import { ExpireScanService } from "./expire-scan.service";

@Controller("admin/expire-scan")
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
}
