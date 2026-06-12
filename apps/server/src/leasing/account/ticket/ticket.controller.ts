import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { TicketService } from "./ticket.service";
import { CreateMessageDto, CreateTicketDto } from "./dto/ticket.dto";

/**
 * TicketController — customer support ticket management.
 *
 * Routes (all @Public() + CustomerJwtGuard):
 *   GET  /api/account/tickets              list tickets (newest first)
 *   POST /api/account/tickets              create ticket (OPEN + first CUSTOMER message)
 *   GET  /api/account/tickets/:id          detail + messages (ownership)
 *   POST /api/account/tickets/:id/messages reply (ownership; 409 if CLOSED; re-open if ANSWERED)
 */
@Controller("account/tickets")
@Public()
@UseGuards(CustomerJwtGuard)
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  /**
   * GET /api/account/tickets
   * → { tickets: [{id,subject,status,createdAt,updatedAt}] }
   */
  @Get()
  list(@CurrentCustomer() customer: CustomerUser) {
    return this.ticketService.list(customer.customerId);
  }

  /**
   * POST /api/account/tickets
   * Body: { subject(≤120), body(≤4000) }
   * → 201 { ticket: {id,subject,status,createdAt} }
   */
  @Post()
  @HttpCode(201)
  create(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: CreateTicketDto,
  ) {
    return this.ticketService.create(customer.customerId, dto.subject, dto.body);
  }

  /**
   * GET /api/account/tickets/:id
   * → { ticket: {id,subject,status,createdAt}, messages: [{id,authorType,body,createdAt}] }
   * Ownership enforced — other customer's ticket → 404 TICKET_NOT_FOUND.
   */
  @Get(":id")
  getDetail(
    @CurrentCustomer() customer: CustomerUser,
    @Param("id") id: string,
  ) {
    return this.ticketService.getDetail(customer.customerId, id);
  }

  /**
   * POST /api/account/tickets/:id/messages
   * Body: { body(≤4000) }
   * → 201 { message: {id,authorType:"CUSTOMER",body,createdAt} }
   * Status CLOSED → 409 { error: "TICKET_CLOSED" }
   * Ownership → 404 TICKET_NOT_FOUND
   */
  @Post(":id/messages")
  @HttpCode(201)
  reply(
    @CurrentCustomer() customer: CustomerUser,
    @Param("id") id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.ticketService.reply(customer.customerId, id, dto.body);
  }
}
