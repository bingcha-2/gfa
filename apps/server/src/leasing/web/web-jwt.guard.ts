/**
 * WebJwtGuard — re-export of CustomerJwtGuard for the web surface.
 *
 * The real implementation lives in customer-auth/customer-jwt.guard.ts.
 * This file is kept for backward-compat import paths used in tests.
 */
export { CustomerJwtGuard as WebJwtGuard } from "./customer-auth/customer-jwt.guard";
