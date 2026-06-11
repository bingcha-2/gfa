import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import type { CustomerUser } from "./customer-jwt.strategy";

/**
 * @CurrentCustomer() — injects the validated customer from request.user.
 * Must be used on endpoints protected by CustomerJwtGuard.
 */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomerUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as CustomerUser;
  }
);
