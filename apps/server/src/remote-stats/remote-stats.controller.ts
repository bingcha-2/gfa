import { Controller, Get, Query } from "@nestjs/common";

import { Public } from "../auth/public.decorator";
import { RemoteStatsService } from "./remote-stats.service";

@Public()
@Controller("remote-stats")
export class RemoteStatsController {
  constructor(private readonly stats: RemoteStatsService) {}

  @Get()
  getStats() {
    return this.stats.getStats();
  }

  /** One-page usage dashboard: health + per-account water levels + bound-card detail. */
  @Get("dashboard")
  getDashboard(@Query("days") days?: string) {
    const n = Number(days);
    return this.stats.getDashboard({ days: Number.isFinite(n) && n > 0 ? n : undefined });
  }
}
