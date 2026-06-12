import { Module } from "@nestjs/common";

import { TicketAdminController } from "./ticket-admin.controller";
import { TicketAdminService } from "./ticket-admin.service";

/**
 * TicketAdminModule — console support-ticket surface (list / detail / reply /
 * status). PrismaModule and AuditLogModule are @Global.
 */
@Module({
  controllers: [TicketAdminController],
  providers: [TicketAdminService],
})
export class TicketAdminModule {}
