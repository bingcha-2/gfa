/**
 * ticket-admin.controller.ts — console support ticket surface.
 *
 *   GET   console/tickets             — list (page/pageSize/status/search)
 *   GET   console/tickets/:id         — detail + messages
 *   POST  console/tickets/:id/messages — admin reply (→ ANSWERED + notify)
 *   PATCH console/tickets/:id         — set status (e.g. CLOSED)
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { AuditLogService } from "../../../shared/audit-log/audit-log.service";
import { TicketAdminService } from "./ticket-admin.service";
import { ReplyTicketDto, UpdateTicketStatusDto } from "./dto/ticket-admin.dto";

@Controller("console/tickets")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class TicketAdminController {
  constructor(
    private readonly ticketAdmin: TicketAdminService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query("status") status?: string,
    @Query("search") search?: string,
  ) {
    return this.ticketAdmin.listTickets({ page, pageSize, status, search });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.ticketAdmin.getTicket(id);
  }

  @Post(":id/messages")
  @HttpCode(201)
  async reply(
    @Param("id") id: string,
    @Body() dto: ReplyTicketDto,
    @Request() req: any,
  ) {
    const result = await this.ticketAdmin.reply(id, req.user?.id, dto.body);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "REPLY_TICKET",
      targetType: "Ticket",
      targetId: id,
    });
    return result;
  }

  @Patch(":id")
  async updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateTicketStatusDto,
    @Request() req: any,
  ) {
    const result = await this.ticketAdmin.updateStatus(id, dto.status);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "UPDATE_TICKET_STATUS",
      targetType: "Ticket",
      targetId: id,
      detail: { status: dto.status },
    });
    return result;
  }
}
