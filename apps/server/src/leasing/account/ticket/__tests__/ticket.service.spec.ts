/**
 * ticket.service.spec.ts — unit tests for TicketService
 *
 * Coverage:
 *   1. list: returns tickets newest first; scoped to customer
 *   2. create: creates OPEN ticket + first CUSTOMER message
 *   3. getDetail: returns ticket + messages; 404 for other's/nonexistent
 *   4. reply: appends message; 409 if CLOSED; re-opens ANSWERED; 404 for other's
 *   5. setUrgent: sets/clears urgent + urgentAt; 409 if CLOSED; 404 for other's
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";

import { TicketService } from "../ticket.service";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<{
  id: string;
  customerId: string;
  subject: string;
  status: string;
  urgent: boolean;
  urgentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messages: any[];
}> = {}) {
  return {
    id: overrides.id ?? "ticket-1",
    customerId: overrides.customerId ?? "cust-1",
    subject: overrides.subject ?? "Help please",
    status: overrides.status ?? "OPEN",
    urgent: overrides.urgent ?? false,
    urgentAt: overrides.urgentAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-06-01T00:00:00Z"),
    messages: overrides.messages ?? [],
  };
}

function makeMessage(overrides: Partial<{
  id: string;
  ticketId: string;
  authorType: string;
  authorId: string | null;
  body: string;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "msg-1",
    ticketId: overrides.ticketId ?? "ticket-1",
    authorType: overrides.authorType ?? "CUSTOMER",
    authorId: overrides.authorId ?? "cust-1",
    body: overrides.body ?? "Hello",
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00Z"),
  };
}

function makePrisma(opts: {
  tickets?: ReturnType<typeof makeTicket>[];
  messages?: ReturnType<typeof makeMessage>[];
} = {}) {
  const tickets = opts.tickets ?? [];
  const messages = opts.messages ?? [];
  let msgSeq = 0;

  return {
    ticket: {
      findMany: vi.fn(async ({ where, orderBy, select }: any) => {
        return tickets
          .filter((t) => {
            if (where?.customerId && t.customerId !== where.customerId) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }),
      findUnique: vi.fn(async ({ where, select }: any) => {
        const t = tickets.find((t) => t.id === where.id) ?? null;
        if (!t) return null;
        // Attach messages if select.messages
        if (select?.messages) {
          return {
            ...t,
            messages: messages
              .filter((m) => m.ticketId === t.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
          };
        }
        return t;
      }),
      create: vi.fn(async ({ data, select }: any) => {
        const id = `ticket-${tickets.length + 1}`;
        const ticket: any = {
          id,
          customerId: data.customerId,
          subject: data.subject,
          status: data.status,
          urgent: data.urgent ?? false,
          urgentAt: data.urgentAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        tickets.push(ticket);
        // Create the first message
        if (data.messages?.create) {
          const msg = {
            id: `msg-${++msgSeq}`,
            ticketId: id,
            authorType: data.messages.create.authorType,
            authorId: data.messages.create.authorId ?? null,
            body: data.messages.create.body,
            createdAt: new Date(),
          };
          messages.push(msg);
        }
        return ticket;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = tickets.findIndex((t) => t.id === where.id);
        if (idx >= 0) {
          tickets[idx] = { ...tickets[idx], ...data };
          return tickets[idx];
        }
        return null;
      }),
    },
    ticketMessage: {
      create: vi.fn(async ({ data, select }: any) => {
        const msg = {
          id: `msg-${++msgSeq}`,
          ticketId: data.ticketId,
          authorType: data.authorType,
          authorId: data.authorId ?? null,
          body: data.body,
          createdAt: new Date(),
        };
        messages.push(msg);
        return msg;
      }),
    },
    $transaction: vi.fn(async (ops: any[]) => {
      const results = [];
      for (const op of ops) {
        results.push(await op);
      }
      return results;
    }),
  };
}

// ── 1. list ───────────────────────────────────────────────────────────────────

describe("TicketService.list", () => {
  it("returns only the customer's tickets ordered newest first", async () => {
    const t1 = makeTicket({ id: "t1", customerId: "cust-1", createdAt: new Date("2026-06-01") });
    const t2 = makeTicket({ id: "t2", customerId: "cust-1", createdAt: new Date("2026-06-03") });
    const other = makeTicket({ id: "t3", customerId: "cust-OTHER" });
    const prisma = makePrisma({ tickets: [t1, t2, other] });
    const service = new TicketService(prisma as any);

    const result = await service.list("cust-1");

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].id).toBe("t2"); // newest first
    expect(result.tickets[1].id).toBe("t1");
  });

  it("ticket shape includes id, subject, status, createdAt, updatedAt as ISO strings", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "ANSWERED" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    const result = await service.list("cust-1");

    expect(result.tickets[0]).toMatchObject({
      id: "t1",
      subject: "Help please",
      status: "ANSWERED",
    });
    expect(typeof result.tickets[0].createdAt).toBe("string");
    expect(typeof result.tickets[0].updatedAt).toBe("string");
  });
});

// ── 2. create ─────────────────────────────────────────────────────────────────

describe("TicketService.create", () => {
  it("creates a ticket with status OPEN, not urgent, and returns it", async () => {
    const prisma = makePrisma();
    const service = new TicketService(prisma as any);

    const result = await service.create("cust-1", "My issue", "Please help me");

    expect(result.ticket.status).toBe("OPEN");
    expect(result.ticket.subject).toBe("My issue");
    expect(result.ticket.urgent).toBe(false);
    expect(result.ticket.urgentAt).toBeNull();
    expect(typeof result.ticket.id).toBe("string");
    expect(typeof result.ticket.createdAt).toBe("string");
  });

  it("creates a first CUSTOMER message as part of ticket creation", async () => {
    const prisma = makePrisma();
    const service = new TicketService(prisma as any);

    await service.create("cust-1", "My issue", "The body of my question");

    // prisma.ticket.create should have been called with a nested message create
    const createCall = (prisma.ticket.create as any).mock.calls[0][0];
    expect(createCall.data.messages.create.authorType).toBe("CUSTOMER");
    expect(createCall.data.messages.create.body).toBe("The body of my question");
  });

  it("returned ticket shape has id, subject, status, urgent, urgentAt, createdAt", async () => {
    const prisma = makePrisma();
    const service = new TicketService(prisma as any);

    const result = await service.create("cust-1", "Subject", "Body");

    expect(result.ticket).toHaveProperty("id");
    expect(result.ticket).toHaveProperty("subject");
    expect(result.ticket).toHaveProperty("status");
    expect(result.ticket).toHaveProperty("urgent");
    expect(result.ticket).toHaveProperty("urgentAt");
    expect(result.ticket).toHaveProperty("createdAt");
    expect(Object.keys(result.ticket)).toHaveLength(6);
  });
});

// ── 3. getDetail ──────────────────────────────────────────────────────────────

describe("TicketService.getDetail", () => {
  it("returns ticket + messages for the owner", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1" });
    const m1 = makeMessage({ id: "m1", ticketId: "t1", authorType: "CUSTOMER", body: "Help" });
    const m2 = makeMessage({ id: "m2", ticketId: "t1", authorType: "ADMIN", body: "Sure" });
    const prisma = makePrisma({ tickets: [t], messages: [m1, m2] });
    const service = new TicketService(prisma as any);

    const result = await service.getDetail("cust-1", "t1");

    expect(result.ticket.id).toBe("t1");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].authorType).toBe("CUSTOMER");
    expect(result.messages[1].authorType).toBe("ADMIN");
  });

  it("throws 404 TICKET_NOT_FOUND when ticket doesn't exist", async () => {
    const prisma = makePrisma({ tickets: [] });
    const service = new TicketService(prisma as any);

    await expect(service.getDetail("cust-1", "nonexistent")).rejects.toThrow(NotFoundException);

    try {
      await service.getDetail("cust-1", "nonexistent");
    } catch (err: any) {
      expect(err.response.error).toBe("TICKET_NOT_FOUND");
    }
  });

  it("throws 404 TICKET_NOT_FOUND when ticket belongs to another customer (ownership)", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-OTHER" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await expect(service.getDetail("cust-1", "t1")).rejects.toThrow(NotFoundException);

    try {
      await service.getDetail("cust-1", "t1");
    } catch (err: any) {
      expect(err.response.error).toBe("TICKET_NOT_FOUND");
    }
  });
});

// ── 4. reply ──────────────────────────────────────────────────────────────────

describe("TicketService.reply", () => {
  it("appends a CUSTOMER message to an OPEN ticket", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "OPEN" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    const result = await service.reply("cust-1", "t1", "Follow-up question");

    expect(result.message.authorType).toBe("CUSTOMER");
    expect(result.message.body).toBe("Follow-up question");
    expect(typeof result.message.id).toBe("string");
    expect(typeof result.message.createdAt).toBe("string");
  });

  it("throws 409 TICKET_CLOSED when ticket status is CLOSED", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "CLOSED" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await expect(service.reply("cust-1", "t1", "body")).rejects.toThrow(ConflictException);

    try {
      await service.reply("cust-1", "t1", "body");
    } catch (err: any) {
      expect(err.response.error).toBe("TICKET_CLOSED");
    }
  });

  it("re-opens ANSWERED ticket to OPEN when customer replies", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "ANSWERED" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await service.reply("cust-1", "t1", "Still not resolved");

    // ticket.update should have been called with status OPEN
    const updateCall = (prisma.ticket.update as any).mock.calls[0][0];
    expect(updateCall.data.status).toBe("OPEN");
  });

  it("throws 404 TICKET_NOT_FOUND when ticket doesn't exist", async () => {
    const prisma = makePrisma({ tickets: [] });
    const service = new TicketService(prisma as any);

    await expect(service.reply("cust-1", "nonexistent", "body")).rejects.toThrow(NotFoundException);

    try {
      await service.reply("cust-1", "nonexistent", "body");
    } catch (err: any) {
      expect(err.response.error).toBe("TICKET_NOT_FOUND");
    }
  });

  it("throws 404 TICKET_NOT_FOUND when ticket belongs to another customer", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-OTHER", status: "OPEN" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await expect(service.reply("cust-1", "t1", "body")).rejects.toThrow(NotFoundException);

    try {
      await service.reply("cust-1", "t1", "body");
    } catch (err: any) {
      expect(err.response.error).toBe("TICKET_NOT_FOUND");
    }
  });
});

// ── 5. setUrgent ────────────────────────────────────────────────────────────────

describe("TicketService.setUrgent", () => {
  it("marks an OPEN ticket urgent and stamps urgentAt", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "OPEN" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    const result = await service.setUrgent("cust-1", "t1", true);

    expect(result.ticket.urgent).toBe(true);
    expect(typeof result.ticket.urgentAt).toBe("string");

    const updateCall = (prisma.ticket.update as any).mock.calls[0][0];
    expect(updateCall.data.urgent).toBe(true);
    expect(updateCall.data.urgentAt).toBeInstanceOf(Date);
  });

  it("clears urgent and nulls urgentAt", async () => {
    const t = makeTicket({
      id: "t1",
      customerId: "cust-1",
      status: "OPEN",
      urgent: true,
      urgentAt: new Date("2026-06-02T00:00:00Z"),
    });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    const result = await service.setUrgent("cust-1", "t1", false);

    expect(result.ticket.urgent).toBe(false);
    expect(result.ticket.urgentAt).toBeNull();

    const updateCall = (prisma.ticket.update as any).mock.calls[0][0];
    expect(updateCall.data.urgent).toBe(false);
    expect(updateCall.data.urgentAt).toBeNull();
  });

  it("throws 409 TICKET_CLOSED when the ticket is CLOSED", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "CLOSED" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await expect(service.setUrgent("cust-1", "t1", true)).rejects.toThrow(ConflictException);

    try {
      await service.setUrgent("cust-1", "t1", true);
    } catch (err: any) {
      expect(err.response.error).toBe("TICKET_CLOSED");
    }
  });

  it("throws 404 TICKET_NOT_FOUND when the ticket belongs to another customer", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-OTHER", status: "OPEN" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await expect(service.setUrgent("cust-1", "t1", true)).rejects.toThrow(NotFoundException);
  });

  it("throws 404 TICKET_NOT_FOUND when the ticket doesn't exist", async () => {
    const prisma = makePrisma({ tickets: [] });
    const service = new TicketService(prisma as any);

    await expect(service.setUrgent("cust-1", "nonexistent", true)).rejects.toThrow(NotFoundException);
  });
});

// ── 6. close (用户自助关闭) ─────────────────────────────────────────────────────

describe("TicketService.close", () => {
  it("置 CLOSED + closedBy=CUSTOMER 并清加急", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "OPEN", urgent: true });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    const res = await service.close("cust-1", "t1");
    expect(res.ticket.status).toBe("CLOSED");
    expect(res.ticket.closedBy).toBe("CUSTOMER");
    const updateCall = (prisma.ticket.update as any).mock.calls[0][0];
    expect(updateCall.data).toMatchObject({
      status: "CLOSED", closedBy: "CUSTOMER", urgent: false, urgentAt: null,
    });
  });

  it("已是 CLOSED → 幂等返回,不再 update", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-1", status: "CLOSED" });
    (t as any).closedBy = "ADMIN";
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    const res = await service.close("cust-1", "t1");
    expect(res.ticket.status).toBe("CLOSED");
    expect(res.ticket.closedBy).toBe("ADMIN");
    expect((prisma.ticket.update as any)).not.toHaveBeenCalled();
  });

  it("他人工单 → 404", async () => {
    const t = makeTicket({ id: "t1", customerId: "cust-OTHER", status: "OPEN" });
    const prisma = makePrisma({ tickets: [t] });
    const service = new TicketService(prisma as any);

    await expect(service.close("cust-1", "t1")).rejects.toThrow(NotFoundException);
  });
});
