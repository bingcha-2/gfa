import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class TicketService {
  constructor(private readonly prisma: PrismaService) {}

  // ── List tickets ──────────────────────────────────────────────────────────

  async list(customerId: string) {
    const tickets = await this.prisma.ticket.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status as string,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    };
  }

  // ── Create ticket ─────────────────────────────────────────────────────────

  async create(customerId: string, subject: string, body: string) {
    const ticket = await this.prisma.ticket.create({
      data: {
        customerId,
        subject,
        status: "OPEN",
        messages: {
          create: {
            authorType: "CUSTOMER",
            authorId: customerId,
            body,
          },
        },
      },
      select: {
        id: true,
        subject: true,
        status: true,
        createdAt: true,
      },
    });

    return {
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status as string,
        createdAt: ticket.createdAt.toISOString(),
      },
    };
  }

  // ── Get ticket detail ─────────────────────────────────────────────────────

  async getDetail(customerId: string, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: {
        id: true,
        customerId: true,
        subject: true,
        status: true,
        createdAt: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            authorType: true,
            body: true,
            createdAt: true,
          },
        },
      },
    });

    if (!ticket || ticket.customerId !== customerId) {
      throw new NotFoundException({ error: "TICKET_NOT_FOUND", message: "Ticket not found" });
    }

    return {
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status as string,
        createdAt: ticket.createdAt.toISOString(),
      },
      messages: ticket.messages.map((m) => ({
        id: m.id,
        authorType: m.authorType,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  // ── Reply to ticket ───────────────────────────────────────────────────────

  async reply(customerId: string, id: string, body: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, customerId: true, status: true },
    });

    if (!ticket || ticket.customerId !== customerId) {
      throw new NotFoundException({ error: "TICKET_NOT_FOUND", message: "Ticket not found" });
    }

    if (ticket.status === "CLOSED") {
      throw new ConflictException({ error: "TICKET_CLOSED", message: "Ticket is closed" });
    }

    // Customer reply: re-open if ANSWERED, keep OPEN if already OPEN
    const newStatus = "OPEN";

    const [message] = await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: "CUSTOMER",
          authorId: customerId,
          body,
        },
        select: {
          id: true,
          authorType: true,
          body: true,
          createdAt: true,
        },
      }),
      this.prisma.ticket.update({
        where: { id },
        data: { status: newStatus },
      }),
    ]);

    return {
      message: {
        id: message.id,
        authorType: message.authorType as "CUSTOMER",
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      },
    };
  }
}
