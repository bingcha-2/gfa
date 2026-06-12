import { Controller, Get } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";

/**
 * AccountSurfaceController — skeleton for the customer account-centre surface.
 *
 * Customer-facing endpoints live in the feature modules behind the Customer
 * JWT guard. Only a public health probe exists here.
 */
@Controller("account")
export class AccountSurfaceController {
  @Public()
  @Get("health")
  health() {
    return { surface: "account", status: "ok" };
  }
}
