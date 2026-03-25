import { Controller, Get } from "@nestjs/common";

import { Public } from "./auth/public.decorator";

@Public()
@Controller("health")
export class HealthController {
  @Get()
  getHealth() {
    return {
      service: "api",
      status: "ok",
      timestamp: new Date().toISOString()
    };
  }
}
