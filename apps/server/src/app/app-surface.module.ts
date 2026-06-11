import { Module } from "@nestjs/common";

import { AppSurfaceController } from "./app-surface.controller";
import { AppAuthModule } from "./app-auth/app-auth.module";

/**
 * AppSurfaceModule — desktop client surface (/api/app/*).
 *
 * Imports AppAuthModule which provides:
 *   - POST /api/app/login
 *   - POST /api/app/heartbeat
 *   - POST /api/app/logout
 */
@Module({
  imports: [AppAuthModule],
  controllers: [AppSurfaceController]
})
export class AppSurfaceModule {}
