import { Module } from "@nestjs/common";

import { WebSurfaceController } from "./web-surface.controller";

/**
 * WebModule — customer web portal surface (/api/web/*).
 *
 * Skeleton for milestone 0; customer auth and endpoints arrive in milestone 2.
 */
@Module({
  controllers: [WebSurfaceController]
})
export class WebModule {}
