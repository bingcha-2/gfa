/**
 * ticket-admin.service.ts — console-side support ticket management. Mirrors the
 * customer-facing ticket.service (account/ticket) but without the ownership
 * check, and an admin reply sets the ticket to ANSWERED and notifies the
 * customer (TICKET notification).
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";

@Injectable()
export class TicketAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listTickets(params: {
    page: number;
    pageSize: number;
    status?: string;
    search?: string;
    urgent?: boolean;
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
    const pageSize = Number.isFinite(params.pageSize)
      ? Math.min(100, Math.max(1, Math.floor(params.pageSize)))
      : 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.TicketWhereInput = {};
    const status = params.status?.trim();
    if (status === "OPEN" || status === "ANSWERED" || status === "CLOSED") {
      where.status = status;
    }
    const search = params.search?.trim();
    if (search) where.customer = { email: { contains: search } };
    if (params.urgent) where.urgent = true;

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        select: {
          id: true,
          subject: true,
          status: true,
          urgent: true,
          urgentAt: true,
          createdAt: true,
          updatedAt: true,
          customer: { select: { email: true } },
          _count: { select: { messages: true } },
        },
        // Urgent tickets float to the top; ties broken by most-recent activity.
        orderBy: [{ urgent: "desc" }, { updatedAt: "desc" }],
        skip,
        take: pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { tickets, total, page, pageSize };
  }

  async getTicket(id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: {
        id: true,
        customerId: true,
        subject: true,
        status: true,
        urgent: true,
        urgentAt: true,
        createdAt: true,
        updatedAt: true,
        customer: { select: { email: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: { id: true, authorType: true, body: true, createdAt: true },
        },
      },
    });
    if (!ticket) throw new NotFoundException(`Ticket "${id}" not found`);
    return ticket;
  }

  /** Admin reply: append ADMIN message, set ANSWERED, notify the customer. */
  async reply(id: string, operatorId: string | undefined, body: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, customerId: true, status: true },
    });
    if (!ticket) throw new NotFoundException(`Ticket "${id}" not found`);
    if (ticket.status === "CLOSED") {
      throw new ConflictException({ error: "TICKET_CLOSED", message: "工单已关闭，无法回复" });
    }

    const [message] = await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: { ticketId: id, authorType: "ADMIN", authorId: operatorId ?? null, body },
        select: { id: true, authorType: true, body: true, createdAt: true },
      }),
      this.prisma.ticket.update({ where: { id }, data: { status: "ANSWERED" } }),
      this.prisma.notification.create({
        data: {
          customerId: ticket.customerId,
          type: "TICKET",
          title: "工单有新回复",
          body: "客服已回复您的工单，请前往「工单」查看。",
        },
      }),
    ]);

    return { message };
  }

  async updateStatus(id: string, status: "OPEN" | "ANSWERED" | "CLOSED") {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!ticket) throw new NotFoundException(`Ticket "${id}" not found`);
    // Closing a ticket auto-clears its urgent flag (a closed ticket no longer
    // needs expediting). Other transitions leave urgent untouched.
    const data: Prisma.TicketUpdateInput =
      status === "CLOSED" ? { status, urgent: false, urgentAt: null } : { status };
    return this.prisma.ticket.update({
      where: { id },
      data,
      select: { id: true, status: true, urgent: true },
    });
  }

  /** Set / clear the urgent flag on any ticket (admin override). */
  async setUrgent(id: string, urgent: boolean) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!ticket) throw new NotFoundException(`Ticket "${id}" not found`);
    // Invariant: a CLOSED ticket is never urgent (close auto-clears it), so
    // reject re-urging a closed ticket. Clearing urgent stays allowed.
    if (urgent && ticket.status === "CLOSED") {
      throw new ConflictException({ error: "TICKET_CLOSED", message: "工单已关闭，无法加急" });
    }
    return this.prisma.ticket.update({
      where: { id },
      data: { urgent, urgentAt: urgent ? new Date() : null },
      select: { id: true, urgent: true, urgentAt: true },
    });
  }
}
