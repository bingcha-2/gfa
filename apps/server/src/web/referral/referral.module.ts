import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { ReferralController } from "./referral.controller";
import { ReferralService } from "./referral.service";

/**
 * ReferralModule — customer referral dashboard.
 *
 * Routes:
 *   GET /api/web/referral  — referral summary
 *
 * NOTE: app.module.ts must import this module to activate the routes.
 */
@Module({
  imports: [CustomerAuthModule],
  controllers: [ReferralController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
