import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../../account/customer-auth/customer-auth.module";
import { DeviceModule } from "../../account/device/device.module";
// TokenServerModule exports SHARED_ACCESS_KEY_STORE — used to read each
// subscription's remaining quota for the client's multi-sub remain bars.
import { TokenServerModule } from "../../token-server/token-server.module";
import { AppAuthService } from "./app-auth.service";
import { AppAuthController } from "./app-auth.controller";

/**
 * AppAuthModule — desktop/mobile client surface auth.
 *
 * Imports CustomerAuthModule to reuse:
 *   - CustomerAuthService (credential validation)
 *   - CustomerTokenService (JWT sign/verify)
 *   - CustomerJwtGuard / CustomerJwtStrategy ("user-jwt" passport strategy)
 *
 * Imports DeviceModule to reuse DeviceService.effectiveDeviceLimit for the
 * login device-limit check (DeviceModule exports the service — this is the
 * clean dependency direction, no circular imports).
 *
 * Adds Device management (upsert on login, heartbeat, logout) and
 * device-limit enforcement at login (403 DEVICE_LIMIT_EXCEEDED).
 */
@Module({
  imports: [CustomerAuthModule, DeviceModule, TokenServerModule],
  controllers: [AppAuthController],
  providers: [AppAuthService]
})
export class AppAuthModule {}
