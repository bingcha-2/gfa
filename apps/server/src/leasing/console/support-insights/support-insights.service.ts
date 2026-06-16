import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";

/**
 * SupportInsightsService —— 后台回看 bot 会话 + 客服运营看板(P3)。
 */
@Injectable()
export class SupportInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 会话列表(可按状态过滤),最近活跃优先。 */
  async listConversations(status?: string) {
    const rows = await this.prisma.supportConversation.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        status: true,
        ticketId: true,
        updatedAt: true,
        customer: { select: { email: true } },
        _count: { select: { messages: true } },
      },
    });
    return {
      conversations: rows.map((c) => ({
        id: c.id,
        status: c.status,
        ticketId: c.ticketId,
        customerEmail: c.customer?.email ?? null,
        messageCount: c._count.messages,
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  }

  /** 单段会话全文(含工具调用痕迹,便于排查 bot 行为)。 */
  async getConversation(id: string) {
    const conv = await this.prisma.supportConversation.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        ticketId: true,
        customer: { select: { email: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true, name: true, createdAt: true },
        },
      },
    });
    if (!conv) throw new NotFoundException({ error: "CONVERSATION_NOT_FOUND" });
    return {
      id: conv.id,
      status: conv.status,
      ticketId: conv.ticketId,
      customerEmail: conv.customer?.email ?? null,
      messages: conv.messages.map((m) => ({
        role: m.role,
        content: m.content,
        name: m.name,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** 运营看板指标。 */
  async stats() {
    const [total, escalated, kbTotal, kbPublished, kbDraft, kbMerge, topKnowledge] =
      await Promise.all([
        this.prisma.supportConversation.count(),
        // 转人工 = 建过工单(ticketId 非空),与会话生命周期(OPEN/CLOSED)正交。
        this.prisma.supportConversation.count({ where: { ticketId: { not: null } } }),
        this.prisma.knowledgeEntry.count({ where: { status: { not: "ARCHIVED" } } }),
        this.prisma.knowledgeEntry.count({ where: { status: "PUBLISHED" } }),
        this.prisma.knowledgeEntry.count({ where: { status: "DRAFT" } }),
        this.prisma.knowledgeEntry.count({ where: { status: "MERGE_SUGGESTED" } }),
        this.prisma.knowledgeEntry.findMany({
          where: { status: "PUBLISHED" },
          orderBy: { usageCount: "desc" },
          take: 5,
          select: { question: true, usageCount: true },
        }),
      ]);

    const escalationRate = total > 0 ? Math.round((escalated / total) * 100) : 0;
    return {
      conversations: {
        total,
        escalated,
        deflected: total - escalated,
        escalationRate, // 百分比整数
      },
      knowledge: {
        total: kbTotal,
        published: kbPublished,
        draft: kbDraft,
        mergeSuggested: kbMerge,
      },
      topKnowledge: topKnowledge.map((k) => ({
        question: k.question,
        usageCount: k.usageCount,
      })),
    };
  }
}
