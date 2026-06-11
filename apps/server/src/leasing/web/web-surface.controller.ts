import { Controller, Get } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";

/**
 * WebSurfaceController — skeleton for the customer web portal surface.
 *
 * Customer-facing endpoints will be added here in milestone 2 behind the
 * Customer JWT guard. For now only a public health probe exists.
 */
@Controller("web")
export class WebSurfaceController {
  @Public()
  @Get("health")
  health() {
    return { surface: "web", status: "ok" };
  }
}
