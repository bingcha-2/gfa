import { Module } from "@nestjs/common";

import { ReferralAdminController } from "./referral-admin.controller";
import { ReferralAdminService } from "./referral-admin.service";

/**
 * ReferralAdminModule — console referral-reward query surface (read-only).
 * PrismaModule is @Global.
 */
@Module({
  controllers: [ReferralAdminController],
  providers: [ReferralAdminService],
})
export class ReferralAdminModule {}
