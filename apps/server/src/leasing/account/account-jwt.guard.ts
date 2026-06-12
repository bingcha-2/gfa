/**
 * AccountJwtGuard — re-export of CustomerJwtGuard for the account surface.
 *
 * The real implementation lives in customer-auth/customer-jwt.guard.ts.
 * This file is kept for surface-named import paths used in tests.
 */
export { CustomerJwtGuard as AccountJwtGuard } from "./customer-auth/customer-jwt.guard";
