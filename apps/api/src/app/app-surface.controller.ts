import { Controller, Get } from "@nestjs/common";

import { Public } from "../auth/public.decorator";

/**
 * AppSurfaceController — skeleton for the desktop client surface.
 *
 * Client-facing endpoints will be added here in milestone 2 behind the
 * Customer session JWT guard. For now only a public health probe exists.
 */
@Controller("app")
export class AppSurfaceController {
  @Public()
  @Get("health")
  health() {
    return { surface: "app", status: "ok" };
  }
}
