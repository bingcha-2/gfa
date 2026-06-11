import { Module } from "@nestjs/common";

import { WebSurfaceController } from "./web-surface.controller";
import { CustomerAuthModule } from "./customer-auth/customer-auth.module";
import { DeviceModule } from "./device/device.module";

/**
 * WebModule — customer web portal surface (/api/web/*).
 *
 * Imports CustomerAuthModule which provides:
 *   - POST /api/web/auth/register
 *   - POST /api/web/auth/login
 *   - POST /api/web/auth/change-password
 *   - POST /api/web/auth/refresh
 *   - GET/PATCH /api/web/me
 *
 * Imports DeviceModule which provides:
 *   - GET   /api/web/devices
 *   - PATCH /api/web/devices/:id
 *   - POST  /api/web/devices/:id/revoke
 */
@Module({
  imports: [CustomerAuthModule, DeviceModule],
  controllers: [WebSurfaceController]
})
export class WebModule {}
