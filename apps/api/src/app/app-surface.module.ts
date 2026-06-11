import { Module } from "@nestjs/common";

import { AppSurfaceController } from "./app-surface.controller";

/**
 * AppSurfaceModule — desktop client surface (/api/app/*).
 *
 * Skeleton for milestone 0; customer session auth and endpoints arrive in
 * milestone 2.
 */
@Module({
  controllers: [AppSurfaceController]
})
export class AppSurfaceModule {}
