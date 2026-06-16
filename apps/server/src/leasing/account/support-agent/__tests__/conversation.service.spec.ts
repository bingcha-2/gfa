/**
 * conversation.service.spec.ts — 会话解析(含 30 分钟空闲新开)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException } from "@nestjs/common";

import { ConversationService } from "../conversation.service";

const MIN = 60 * 1000;
function ago(ms: number) {
  return new Date(Date.now() - ms);
}

function makePrisma() {
  return {
    supportConversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "new", customerId: "c", status: "OPEN", ticketId: null }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    supportMessage: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe("ConversationService.resolve", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: ConversationService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new ConversationService(prisma as any);
  });

  it("近期会话(<30min)且属于本人 → 复用", async () => {
    prisma.supportConversation.findUnique.mockResolvedValue({
      id: "c1", customerId: "me", status: "OPEN", ticketId: null, updatedAt: ago(5 * MIN),
    });
    const out = await svc.resolve("me", "c1");
    expect(out.id).toBe("c1");
    expect(prisma.supportConversation.create).not.toHaveBeenCalled();
  });

  it("空闲超 30min → 关旧 OPEN + 开新会话", async () => {
    prisma.supportConversation.findUnique.mockResolvedValue({
      id: "c1", customerId: "me", status: "OPEN", ticketId: null, updatedAt: ago(31 * MIN),
    });
    const out = await svc.resolve("me", "c1");
    expect(prisma.supportConversation.update).toHaveBeenCalledWith({
      where: { id: "c1" }, data: { status: "CLOSED" },
    });
    expect(prisma.supportConversation.create).toHaveBeenCalled();
    expect(out.id).toBe("new");
  });

  it("他人会话 → 403", async () => {
    prisma.supportConversation.findUnique.mockResolvedValue({
      id: "c1", customerId: "other", status: "OPEN", ticketId: null, updatedAt: ago(1 * MIN),
    });
    await expect(svc.resolve("me", "c1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("无 id → 新建", async () => {
    const out = await svc.resolve("me");
    expect(prisma.supportConversation.create).toHaveBeenCalled();
    expect(out.id).toBe("new");
  });
});

describe("ConversationService.markEscalated / closeIdleConversations", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: ConversationService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new ConversationService(prisma as any);
  });

  it("markEscalated 只写 ticketId,不动 status", async () => {
    await svc.markEscalated("c1", "t9");
    expect(prisma.supportConversation.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { ticketId: "t9" },
    });
  });

  it("closeIdleConversations:把空闲 OPEN 批量置 CLOSED,返回条数", async () => {
    prisma.supportConversation.updateMany.mockResolvedValue({ count: 3 });
    const n = await svc.closeIdleConversations();
    expect(n).toBe(3);
    const arg = prisma.supportConversation.updateMany.mock.calls[0][0];
    expect(arg.where.status).toBe("OPEN");
    expect(arg.data).toEqual({ status: "CLOSED" });
  });
});

describe("ConversationService.getLatestForCustomer", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: ConversationService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new ConversationService(prisma as any);
  });

  it("最近一段已空闲超 30min → null(重开即新会话)", async () => {
    prisma.supportConversation.findFirst.mockResolvedValue({
      id: "c1", status: "OPEN", ticketId: null, updatedAt: ago(31 * MIN),
    });
    expect(await svc.getLatestForCustomer("me")).toBeNull();
    expect(prisma.supportMessage.findMany).not.toHaveBeenCalled();
  });

  it("近期会话 → 返回视图", async () => {
    prisma.supportConversation.findFirst.mockResolvedValue({
      id: "c1", status: "OPEN", ticketId: null, updatedAt: ago(2 * MIN),
    });
    prisma.supportMessage.findMany.mockResolvedValue([
      { role: "USER", content: "在吗", createdAt: new Date() },
    ]);
    const out = await svc.getLatestForCustomer("me");
    expect(out?.id).toBe("c1");
    expect(out?.messages.length).toBe(1);
  });
});
