import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { TicketController } from "./ticket.controller";
import { TicketService } from "./ticket.service";

/**
 * TicketModule — customer support tickets.
 *
 * Routes:
 *   GET  /api/web/tickets              list tickets
 *   POST /api/web/tickets              create ticket
 *   GET  /api/web/tickets/:id          detail + messages
 *   POST /api/web/tickets/:id/messages reply
 *
 * NOTE: app.module.ts must import this module to activate the routes.
 */
@Module({
  imports: [CustomerAuthModule],
  controllers: [TicketController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketModule {}
