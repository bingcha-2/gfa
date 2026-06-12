/**
 * ticket-admin.service.spec.ts — console support-ticket management against the
 * real Prisma test db. cleanCustomerTables does NOT touch Ticket/TicketMessage,
 * so this suite clears them first (FK-safe: messages → tickets → customers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";

import { TicketAdminService } from "../ticket-admin.service";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

const prisma = getCustomerPrisma();
let seq = 0;
let service: TicketAdminService;

async function cleanTickets() {
  await prisma.ticketMessage.deleteMany();
  await prisma.ticket.deleteMany();
}

async function createTicket(customerId: string, overrides: Partial<{ subject: string; status: string }> = {}) {
  return prisma.ticket.create({
    data: {
      customerId,
      subject: overrides.subject ?? `工单 ${++seq}`,
      status: (overrides.status ?? "OPEN") as any,
      messages: { create: { authorType: "CUSTOMER", authorId: customerId, body: "客户首条留言" } },
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanTickets();
  await cleanCustomerTables();
  service = new TicketAdminService(prisma as any);
});

afterAll(async () => {
  await cleanTickets();
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("TicketAdminService.listTickets", () => {
  it("joins customer email + message count, filters by status, searches email", async () => {
    const c1 = await createTestCustomer({ email: "a@ticket.test" });
    const c2 = await createTestCustomer({ email: "b@ticket.test" });
    await createTicket(c1.id, { status: "OPEN" });
    await createTicket(c2.id, { status: "CLOSED" });

    const all = await service.listTickets({ page: 1, pageSize: 20 });
    expect(all.total).toBe(2);
    expect(all.tickets[0].customer?.email).toBeDefined();
    expect(all.tickets[0]._count.messages).toBe(1);

    const open = await service.listTickets({ page: 1, pageSize: 20, status: "OPEN" });
    expect(open.total).toBe(1);

    const byEmail = await service.listTickets({ page: 1, pageSize: 20, search: "a@ticket" });
    expect(byEmail.total).toBe(1);
  });
});

describe("TicketAdminService.getTicket", () => {
  it("returns detail with ordered messages; 404 for unknown", async () => {
    const customer = await createTestCustomer();
    const ticket = await createTicket(customer.id);

    const detail = await service.getTicket(ticket.id);
    expect(detail.id).toBe(ticket.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].authorType).toBe("CUSTOMER");

    await expect(service.getTicket("no-such-ticket")).rejects.toThrow(NotFoundException);
  });
});

describe("TicketAdminService.reply", () => {
  it("appends an ADMIN message, sets ANSWERED, and notifies the customer (TICKET)", async () => {
    const customer = await createTestCustomer();
    const ticket = await createTicket(customer.id, { status: "OPEN" });

    const { message } = await service.reply(ticket.id, "operator-1", "已为您处理。");

    expect(message.authorType).toBe("ADMIN");
    const refreshed = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    expect(refreshed!.status).toBe("ANSWERED");

    const msgs = await prisma.ticketMessage.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => m.authorType)).toEqual(["CUSTOMER", "ADMIN"]);

    const notifs = await prisma.notification.findMany({ where: { customerId: customer.id, type: "TICKET" } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe("工单有新回复");
  });

  it("rejects replying to a CLOSED ticket with 409", async () => {
    const customer = await createTestCustomer();
    const ticket = await createTicket(customer.id, { status: "CLOSED" });
    await expect(service.reply(ticket.id, "operator-1", "x")).rejects.toThrow(ConflictException);
  });

  it("throws 404 for an unknown ticket", async () => {
    await expect(service.reply("no-such-ticket", "operator-1", "x")).rejects.toThrow(NotFoundException);
  });
});

describe("TicketAdminService.updateStatus", () => {
  it("sets the status; 404 for unknown", async () => {
    const customer = await createTestCustomer();
    const ticket = await createTicket(customer.id, { status: "ANSWERED" });

    const result = await service.updateStatus(ticket.id, "CLOSED");
    expect(result.status).toBe("CLOSED");

    await expect(service.updateStatus("no-such-ticket", "CLOSED")).rejects.toThrow(NotFoundException);
  });
});
