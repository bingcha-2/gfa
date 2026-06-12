import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { DeviceService } from "./device.service";
import { DeviceController } from "./device.controller";

/**
 * DeviceModule — customer device management (Milestone 6).
 *
 * Routes (all guarded by CustomerJwtGuard via CustomerAuthModule):
 *   - GET   /api/account/devices            list devices + effective device limit
 *   - PATCH /api/account/devices/:id        rename a device
 *   - POST  /api/account/devices/:id/revoke revoke a device (REVOKED + sessionJti=null)
 *
 * Exports DeviceService so AppAuthModule can reuse effectiveDeviceLimit for
 * login device-limit enforcement (clean direction — no circular imports).
 */
@Module({
  imports: [CustomerAuthModule],
  controllers: [DeviceController],
  providers: [DeviceService],
  exports: [DeviceService]
})
export class DeviceModule {}
