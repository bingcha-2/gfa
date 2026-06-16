import { ForbiddenException, Injectable } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { ChatMessage, LlmToolCall } from "./llm/llm.types";

/** 对话 + 消息(用于客户端展示)。 */
export interface ConversationView {
  id: string;
  status: string;
  ticketId: string | null;
  messages: { role: "USER" | "ASSISTANT"; content: string; createdAt: string }[];
}

/** 回灌给模型的对话历史轮数上限(防止上下文超长)。 */
const HISTORY_LIMIT = 20;
/** 会话空闲超过此时长(30 分钟)再进来,视为新会话,不再续聊旧上下文。 */
const SESSION_IDLE_MS = 30 * 60 * 1000;

function isStale(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() >= SESSION_IDLE_MS;
}

/**
 * ConversationService —— 客服会话与消息的持久化。
 *
 * 落库的是「全量」(含 assistant 的 tool_calls、tool 结果)用于审计;
 * 但回灌给模型的历史只取 USER/ASSISTANT 的纯文本轮次(getRecentDialogue),
 * 避免重建 tool_call↔tool 配对的复杂度 —— 每个新用户轮 agent 重新按需调工具。
 */
@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 解析会话:给了 id 且属于本人、且未超过 30 分钟空闲 → 复用;
   * 属于他人 → 403;找不到 / 已超 30 分钟空闲 → 新建(旧的若仍 OPEN 顺手关闭)。
   */
  async resolve(customerId: string, conversationId?: string) {
    if (conversationId) {
      const existing = await this.prisma.supportConversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true, customerId: true, status: true, ticketId: true, updatedAt: true,
        },
      });
      if (existing) {
        if (existing.customerId !== customerId) {
          throw new ForbiddenException({ error: "CONVERSATION_FORBIDDEN" });
        }
        if (!isStale(existing.updatedAt)) {
          const { updatedAt, ...rest } = existing;
          return rest;
        }
        // 空闲超 30 分钟:旧会话 OPEN 的关掉,开新会话。
        if (existing.status === "OPEN") {
          await this.prisma.supportConversation.update({
            where: { id: existing.id },
            data: { status: "CLOSED" },
          });
        }
      }
    }
    return this.prisma.supportConversation.create({
      data: { customerId },
      select: { id: true, customerId: true, status: true, ticketId: true },
    });
  }

  /** 统计该客户在 since 之后发出的消息数(限流用,跨所有会话)。 */
  async countUserMessagesSince(customerId: string, since: Date): Promise<number> {
    return this.prisma.supportMessage.count({
      where: {
        role: "USER",
        createdAt: { gte: since },
        conversation: { customerId },
      },
    });
  }

  async appendUserMessage(conversationId: string, content: string) {
    await this.prisma.supportConversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        messages: { create: { role: "USER", content } },
      },
    });
  }

  async appendAssistantMessage(
    conversationId: string,
    content: string,
    toolCalls?: LlmToolCall[],
  ) {
    await this.prisma.supportConversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        messages: {
          create: {
            role: "ASSISTANT",
            content,
            toolCalls:
              toolCalls && toolCalls.length > 0
                ? JSON.stringify(toolCalls)
                : null,
          },
        },
      },
    });
  }

  async appendToolMessage(
    conversationId: string,
    name: string,
    content: string,
  ) {
    await this.prisma.supportConversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        messages: { create: { role: "TOOL", content, name } },
      },
    });
  }

  /** 取回灌给模型的对话历史:仅 USER/ASSISTANT 的纯文本轮次,按时间正序。 */
  async getRecentDialogue(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.prisma.supportMessage.findMany({
      where: {
        conversationId,
        role: { in: ["USER", "ASSISTANT"] },
        toolCalls: null,
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });
    return rows
      .filter((r) => r.content.trim().length > 0)
      .slice(-HISTORY_LIMIT)
      .map((r) => ({
        role: r.role === "USER" ? "user" : "assistant",
        content: r.content,
      }));
  }

  /**
   * 标记本会话已转人工:只写 ticketId,不动 status。
   * 「是否转人工」是独立维度(看 ticketId),与会话生命周期(OPEN/CLOSED)正交。
   */
  async markEscalated(conversationId: string, ticketId: string) {
    await this.prisma.supportConversation.update({
      where: { id: conversationId },
      data: { ticketId },
    });
  }

  /**
   * 定时清扫:把空闲超过 30 分钟、仍 OPEN 的会话置 CLOSED(已转人工的保留 ticketId)。
   * 让"已结束"及时反映到看板,而不是等用户回来才懒关闭。返回关闭条数。
   */
  async closeIdleConversations(): Promise<number> {
    const cutoff = new Date(Date.now() - SESSION_IDLE_MS);
    const res = await this.prisma.supportConversation.updateMany({
      where: { status: "OPEN", updatedAt: { lt: cutoff } },
      data: { status: "CLOSED" },
    });
    return res.count;
  }

  /**
   * 客户端展示用:取该客户最近一段对话(纯文本消息)。
   * 若最近一段已空闲超 30 分钟,视为已结束,返回 null —— 重开气泡即是新会话。
   */
  async getLatestForCustomer(
    customerId: string,
  ): Promise<ConversationView | null> {
    const conv = await this.prisma.supportConversation.findFirst({
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, status: true, ticketId: true, updatedAt: true },
    });
    if (!conv) return null;
    if (isStale(conv.updatedAt)) return null;

    const rows = await this.prisma.supportMessage.findMany({
      where: {
        conversationId: conv.id,
        role: { in: ["USER", "ASSISTANT"] },
        toolCalls: null,
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true, createdAt: true },
    });

    return {
      id: conv.id,
      status: conv.status,
      ticketId: conv.ticketId,
      messages: rows
        .filter((r) => r.content.trim().length > 0)
        .map((r) => ({
          role: r.role as "USER" | "ASSISTANT",
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
    };
  }
}
