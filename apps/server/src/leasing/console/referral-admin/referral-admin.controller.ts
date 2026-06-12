/**
 * referral-admin.controller.ts — console referral-reward query (read-only).
 *
 *   GET console/referral-rewards — list (page/pageSize/status/search)
 */
import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { ReferralAdminService } from "./referral-admin.service";

@Controller("console/referral-rewards")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class ReferralAdminController {
  constructor(private readonly referralAdmin: ReferralAdminService) {}

  @Get()
  list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query("status") status?: string,
    @Query("search") search?: string,
  ) {
    return this.referralAdmin.listRewards({ page, pageSize, status, search });
  }
}
