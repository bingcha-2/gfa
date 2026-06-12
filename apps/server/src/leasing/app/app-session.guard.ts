/**
 * AppSessionGuard — re-export of CustomerJwtGuard for the app surface.
 *
 * The real implementation lives in web/customer-auth/customer-jwt.guard.ts
 * (single guard for both surfaces; strategy is "user-jwt").
 */
export { CustomerJwtGuard as AppSessionGuard } from "../account/customer-auth/customer-jwt.guard";
