import { Module } from "@nestjs/common";

import { AppSurfaceController } from "./app-surface.controller";
import { AppAuthModule } from "./app-auth/app-auth.module";
import { ReferralModule } from "../account/referral/referral.module";

/**
 * AppSurfaceModule — desktop client surface (/api/app/*).
 *
 * Imports AppAuthModule which provides:
 *   - POST /api/app/login
 *   - POST /api/app/heartbeat
 *   - POST /api/app/logout
 * ReferralModule provides ReferralService for POST /api/app/referral.
 */
@Module({
  imports: [AppAuthModule, ReferralModule],
  controllers: [AppSurfaceController]
})
export class AppSurfaceModule {}
