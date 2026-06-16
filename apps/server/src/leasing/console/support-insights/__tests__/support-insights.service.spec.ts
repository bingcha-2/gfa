/**
 * support-insights.service.spec.ts — 会话回看 + 看板指标
 */
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

import { SupportInsightsService } from "../support-insights.service";

function makePrisma() {
  return {
    supportConversation: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    knowledgeEntry: { count: vi.fn(), findMany: vi.fn() },
  };
}

describe("SupportInsightsService", () => {
  it("stats:升级率与知识计数", async () => {
    const prisma = makePrisma();
    prisma.supportConversation.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(3); // escalated
    prisma.knowledgeEntry.count
      .mockResolvedValueOnce(8) // total(非归档)
      .mockResolvedValueOnce(5) // published
      .mockResolvedValueOnce(2) // draft
      .mockResolvedValueOnce(1); // merge
    prisma.knowledgeEntry.findMany.mockResolvedValue([
      { question: "怎么登录", usageCount: 9 },
    ]);

    const svc = new SupportInsightsService(prisma as any);
    const s = await svc.stats();
    expect(s.conversations).toEqual({ total: 10, escalated: 3, deflected: 7, escalationRate: 30 });
    expect(s.knowledge).toEqual({ total: 8, published: 5, draft: 2, mergeSuggested: 1 });
    expect(s.topKnowledge[0]).toEqual({ question: "怎么登录", usageCount: 9 });
  });

  it("listConversations:映射客户邮箱与消息数", async () => {
    const prisma = makePrisma();
    prisma.supportConversation.findMany.mockResolvedValue([
      {
        id: "c1", status: "ESCALATED", ticketId: "t1",
        updatedAt: new Date("2026-06-16T00:00:00Z"),
        customer: { email: "a@b.com" }, _count: { messages: 4 },
      },
    ]);
    const svc = new SupportInsightsService(prisma as any);
    const out = await svc.listConversations("ESCALATED");
    expect(out.conversations[0]).toMatchObject({
      id: "c1", customerEmail: "a@b.com", messageCount: 4, ticketId: "t1",
    });
  });

  it("getConversation:不存在 → 404", async () => {
    const prisma = makePrisma();
    prisma.supportConversation.findUnique.mockResolvedValue(null);
    const svc = new SupportInsightsService(prisma as any);
    await expect(svc.getConversation("x")).rejects.toBeInstanceOf(NotFoundException);
  });
});
