import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";

/**
 * NotificationModule — customer notification inbox.
 *
 * Routes:
 *   GET  /api/account/notifications            list + unread count
 *   POST /api/account/notifications/:id/read   mark one read (ownership)
 *   POST /api/account/notifications/read-all   mark all unread read
 *
 * NOTE: app.module.ts must import this module to activate the routes.
 */
@Module({
  imports: [CustomerAuthModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
