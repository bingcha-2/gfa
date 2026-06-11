import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../../web/customer-auth/customer-auth.module";
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
 * Adds Device management (upsert on login, heartbeat, logout).
 */
@Module({
  imports: [CustomerAuthModule],
  controllers: [AppAuthController],
  providers: [AppAuthService]
})
export class AppAuthModule {}
