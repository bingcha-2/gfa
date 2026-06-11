import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { TokenServerModule } from "../../token-server/token-server.module";
import { PortalController, UsageController } from "./portal.controller";
import { PortalService } from "./portal.service";

/**
 * PortalModule — customer web portal overview, quota, and usage history.
 *
 * Routes:
 *   GET /api/web/portal/overview   — KPI snapshot (customer, subscriptions, devices, notifications)
 *   GET /api/web/usage             — paginated token usage history
 *
 * Imports:
 *   - CustomerAuthModule  → CustomerJwtGuard + CustomerJwtStrategy
 *   - TokenServerModule   → SHARED_ACCESS_KEY_STORE (quota data)
 *
 * NOTE: app.module.ts must import this module to activate the routes.
 */
@Module({
  imports: [CustomerAuthModule, TokenServerModule],
  controllers: [PortalController, UsageController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
