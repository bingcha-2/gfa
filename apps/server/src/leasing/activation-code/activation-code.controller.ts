import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

import { Public } from "../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../account/customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../account/customer-auth/customer.decorator";
import type { CustomerUser } from "../account/customer-auth/customer-jwt.strategy";
import { ActivationCodeService } from "./activation-code.service";
import { ActivateCodeDto } from "./dto/activate-code.dto";

/**
 * POST /api/account/activate-code — 登录客户兑换激活码,开通一条独立订阅。
 *
 * @Public() 跳过全局 admin JwtAuthGuard;CustomerJwtGuard 强制客户会话。
 * @SkipThrottle():激活幂等且按 UNUSED→ACTIVATED CAS 自串行,重试不应被全局限流挡住。
 */
@Controller("account")
export class ActivationCodeController {
  constructor(private readonly activationCode: ActivationCodeService) {}

  @Public()
  @UseGuards(CustomerJwtGuard)
  @SkipThrottle()
  @Post("activate-code")
  activate(@CurrentCustomer() customer: CustomerUser, @Body() dto: ActivateCodeDto) {
    return this.activationCode.activate(customer.customerId, dto.code);
  }
}
