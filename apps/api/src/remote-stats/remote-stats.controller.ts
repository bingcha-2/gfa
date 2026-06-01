import { Controller, Get } from "@nestjs/common";

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
}
