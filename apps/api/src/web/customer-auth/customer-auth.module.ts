import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { CustomerAuthService } from "./customer-auth.service";
import { CustomerTokenService } from "./customer-token.service";
import { CustomerEmailTokenService } from "./customer-email-token.service";
import { CustomerJwtStrategy } from "./customer-jwt.strategy";
import { CustomerJwtGuard } from "./customer-jwt.guard";
import { CustomerAuthController } from "./customer-auth.controller";
import { CustomerProfileController } from "./customer-profile.controller";

/**
 * CustomerAuthModule — web surface customer auth.
 *
 * Registers the "user-jwt" passport strategy which is fully independent from
 * the admin "jwt" strategy: different secret (CUSTOMER_JWT_SECRET), different
 * typ claim ("user-session" vs absent), different Prisma model (Customer vs User).
 *
 * Exports: CustomerAuthService, CustomerTokenService, CustomerJwtGuard, CustomerJwtStrategy
 * so AppAuthModule can reuse them without re-registering.
 *
 * MailModule is @Global() so MailService is available here without an explicit import.
 */
@Module({
  imports: [
    // PassportModule registers the passport runtime; strategy name is "user-jwt"
    PassportModule.register({ defaultStrategy: "user-jwt" }),
    // A minimal JwtModule instance for CustomerTokenService.
    // We do NOT share the admin JwtModule (different secret + options).
    // Secret is resolved at call-time in CustomerTokenService.sign/verify,
    // so this registration is just to provide JwtService; secret here is a
    // harmless placeholder — all actual sign/verify calls pass explicit options.
    JwtModule.register({ secret: "placeholder-overridden-per-call" })
  ],
  controllers: [CustomerAuthController, CustomerProfileController],
  providers: [
    CustomerAuthService,
    CustomerTokenService,
    CustomerEmailTokenService,
    CustomerJwtStrategy,
    CustomerJwtGuard
  ],
  exports: [
    CustomerAuthService,
    CustomerTokenService,
    CustomerEmailTokenService,
    CustomerJwtGuard,
    CustomerJwtStrategy
  ]
})
export class CustomerAuthModule {}
