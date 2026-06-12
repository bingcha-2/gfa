import { Module } from "@nestjs/common";

import { AccountSurfaceController } from "./account-surface.controller";
import { CustomerAuthModule } from "./customer-auth/customer-auth.module";
import { DeviceModule } from "./device/device.module";

/**
 * AccountModule — customer account-centre surface (/api/account/*).
 *
 * Imports CustomerAuthModule which provides:
 *   - POST /api/account/auth/register
 *   - POST /api/account/auth/login
 *   - POST /api/account/auth/change-password
 *   - POST /api/account/auth/refresh
 *   - GET/PATCH /api/account/me
 *
 * Imports DeviceModule which provides:
 *   - GET   /api/account/devices
 *   - PATCH /api/account/devices/:id
 *   - POST  /api/account/devices/:id/revoke
 */
@Module({
  imports: [CustomerAuthModule, DeviceModule],
  controllers: [AccountSurfaceController]
})
export class AccountModule {}
