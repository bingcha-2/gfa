import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";

import { BillingService } from "../billing/billing.service";
import { CustomerAuthService } from "../customer-auth/customer-auth.service";
import { TicketService } from "../ticket/ticket.service";
import { KnowledgeService } from "../../support-knowledge/knowledge.service";
import { ConversationService } from "./conversation.service";
import { LlmClient } from "./llm/llm.client";
import { loadSupportRateLimits, SupportRateLimits } from "./llm/llm.config";
import { ChatMessage, LlmToolCall } from "./llm/llm.types";
import { buildSystemPrompt } from "./prompt/system-prompt";
import { SseEvent } from "./support-agent.types";
import { buildTools, toolSchemas } from "./tools";
import { AgentTool, ToolContext, TOOL_RESULT_MAX_CHARS } from "./tools/types";

const UNAVAILABLE_MSG =
  "客服助手暂时不可用,请稍后再试,或前往「工单」联系人工客服。";
const TOO_FAST_MSG = "你发送得太频繁啦,请稍等一会儿再发。";
const DAILY_LIMIT_MSG =
  "你今天的咨询次数已达上限,如仍需帮助,请前往「工单」联系人工客服。";
const FALLBACK_MSG =
  "抱歉,我暂时没能帮你处理好这个问题。我可以帮你转人工客服,或你稍后再试一次。";

/**
 * SupportAgentService —— 客服 agent 编排(工具循环 + 流式 + 兜底)。
 *
 * run() 是 async generator,逐个 yield SSE 事件;控制器把它转成 SSE 流。
 * 工具在服务端执行并注入可信 customerId;任何模型/网络/工具异常都降级为
 * 友好兜底,不抛 500、不向客户暴露内部细节。
 */
@Injectable()
export class SupportAgentService {
  private readonly logger = new Logger(SupportAgentService.name);
  private readonly tools: Map<string, AgentTool>;
  private readonly rateLimits: SupportRateLimits = loadSupportRateLimits();

  constructor(
    private readonly llm: LlmClient,
    private readonly conversations: ConversationService,
    private readonly knowledge: KnowledgeService,
    private readonly tickets: TicketService,
    customerAuth: CustomerAuthService,
    billing: BillingService,
  ) {
    // 「全塞」模式:知识不走检索工具,运行时整段拼进系统提示词。
    this.tools = buildTools({ profile: customerAuth, billing, tickets: this.tickets });
  }

  get enabled(): boolean {
    return this.llm.enabled;
  }

  async *run(
    ctx: ToolContext,
    conversationId: string | undefined,
    userText: string,
  ): AsyncGenerator<SseEvent> {
    if (!this.llm.enabled) {
      yield { type: "error", message: UNAVAILABLE_MSG };
      return;
    }

    // 防刷限流(在调用大模型之前):按客户的发送次数,每分钟 + 每天上限。
    const now = Date.now();
    const [perMin, perDay] = await Promise.all([
      this.conversations.countUserMessagesSince(ctx.customerId, new Date(now - 60_000)),
      this.conversations.countUserMessagesSince(ctx.customerId, new Date(now - 86_400_000)),
    ]);
    if (perMin >= this.rateLimits.perMinute) {
      yield { type: "error", message: TOO_FAST_MSG };
      return;
    }
    if (perDay >= this.rateLimits.perDay) {
      yield { type: "error", message: DAILY_LIMIT_MSG };
      return;
    }

    let conv: { id: string; ticketId?: string | null };
    try {
      conv = await this.conversations.resolve(ctx.customerId, conversationId);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        yield { type: "error", message: "无法访问该会话。" };
        return;
      }
      throw err;
    }

    yield { type: "meta", conversationId: conv.id };

    await this.conversations.appendUserMessage(conv.id, userText);
    const [history, kb] = await Promise.all([
      this.conversations.getRecentDialogue(conv.id),
      this.knowledge.listPublishedQA(),
    ]);

    // 已转人工的会话:额外给 bot 一个「追加到工单」工具,并在提示词里说明,
    // 由 bot 自己判断——是把补充同步给人工、还是这条它能直接答。
    const tools = new Map(this.tools);
    let systemContent = buildSystemPrompt(kb);
    if (conv.ticketId) {
      tools.set("add_to_ticket", this.makeAddToTicketTool(conv.ticketId));
      systemContent += escalatedNote();
    }

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...history,
    ];
    const schemas = toolSchemas(tools);

    let finalAnswer = "";
    // 已转人工的会话默认沿用原工单;若本轮新建工单则覆盖。
    let escalationTicketId: string | null = conv.ticketId ?? null;

    for (let i = 0; i < this.llm.maxToolIters; i++) {
      let content = "";
      let toolCalls: LlmToolCall[] = [];

      try {
        for await (const ev of this.llm.streamChat(messages, schemas)) {
          if (ev.type === "delta") {
            if (ev.text) yield { type: "delta", text: ev.text };
          } else {
            content = ev.content;
            toolCalls = ev.toolCalls;
          }
        }
      } catch (err) {
        this.logger.error(`streamChat failed: ${stringifyErr(err)}`);
        yield { type: "delta", text: FALLBACK_MSG };
        await this.conversations.appendAssistantMessage(conv.id, FALLBACK_MSG);
        yield { type: "done", conversationId: conv.id, ticketId: escalationTicketId };
        return;
      }

      // 无工具调用(含 function-calling 解析失败降级为纯文本)→ 终答。
      if (toolCalls.length === 0) {
        finalAnswer = content;
        break;
      }

      // 记录 assistant(含 tool_calls)用于审计,并喂回模型。
      await this.conversations.appendAssistantMessage(conv.id, content, toolCalls);
      messages.push({ role: "assistant", content, toolCalls });

      for (const call of toolCalls) {
        yield { type: "tool", name: call.name };
        const result = await this.executeTool(call, ctx, tools);
        if (call.name === "create_support_ticket") {
          const tid = (result as { ticketId?: unknown }).ticketId;
          if (typeof tid === "string") escalationTicketId = tid;
        }
        const resultStr = truncate(safeStringify(result), TOOL_RESULT_MAX_CHARS);
        await this.conversations.appendToolMessage(conv.id, call.name, resultStr);
        messages.push({
          role: "tool",
          content: resultStr,
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    // 跑满轮数仍无终答 → 兜底。
    if (!finalAnswer) {
      finalAnswer = FALLBACK_MSG;
      yield { type: "delta", text: FALLBACK_MSG };
    }

    await this.conversations.appendAssistantMessage(conv.id, finalAnswer);
    // 只有新建/变更了工单才回写(已转人工沿用原工单时不重复写)。
    if (escalationTicketId && escalationTicketId !== conv.ticketId) {
      await this.conversations.markEscalated(conv.id, escalationTicketId);
    }
    yield { type: "done", conversationId: conv.id, ticketId: escalationTicketId };
  }

  /**
   * 已转人工会话专属工具:把客户补充追加到当前工单(由 bot 自行判断是否调用)。
   * ticketId 由会话绑定(闭包),不接受模型传入;工单已关闭则回 {ok:false},
   * 让 bot 改用 create_support_ticket 另建。
   */
  private makeAddToTicketTool(ticketId: string): AgentTool {
    return {
      schema: {
        name: "add_to_ticket",
        description:
          "本会话已转人工(有进行中的工单)。当客户是在补充/更新与该工单相关的信息或进展时,调用本工具把内容同步给人工客服。若客户问的是你能直接解答的新问题,就正常回答、不要调用本工具。",
        parameters: {
          type: "object",
          properties: {
            note: { type: "string", description: "要同步给人工的客户补充内容" },
          },
          required: ["note"],
          additionalProperties: false,
        },
      },
      handler: async (args, ctx) => {
        const note =
          typeof args.note === "string" && args.note.trim()
            ? args.note.trim()
            : "";
        if (!note) return { ok: false, reason: "空内容" };
        try {
          await this.tickets.reply(ctx.customerId, ticketId, note);
          return { ok: true };
        } catch (err) {
          if (
            err instanceof ConflictException ||
            (err as { status?: number })?.status === 404
          ) {
            // 工单已关闭/不存在:告诉模型,让它改用 create_support_ticket 另建。
            return { ok: false, reason: "ticket_closed" };
          }
          this.logger.warn(`add_to_ticket failed: ${stringifyErr(err)}`);
          return { ok: false, reason: "error" };
        }
      },
    };
  }

  /** 执行一次工具调用:解析参数 + 调 handler,任何异常都收敛为 {error}。 */
  private async executeTool(
    call: LlmToolCall,
    ctx: ToolContext,
    tools: Map<string, AgentTool>,
  ): Promise<Record<string, unknown>> {
    const tool = tools.get(call.name);
    if (!tool) return { error: `未知工具:${call.name}` };

    let args: Record<string, unknown> = {};
    if (call.arguments && call.arguments.trim()) {
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return { error: "参数解析失败" };
      }
    }

    try {
      return (await tool.handler(args, ctx)) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`tool ${call.name} failed: ${stringifyErr(err)}`);
      return { error: "工具执行失败,请稍后再试。" };
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return '{"error":"结果无法序列化"}';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…(已截断)` : s;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 已转人工会话附加到系统提示词的说明,指导 bot 如何对待后续消息。 */
function escalatedNote(): string {
  return `

## 当前会话已转人工(工单进行中)
对客户接下来的消息,你自行判断:
- 若客户是在**补充/更新与该工单相关的信息或进展**(包括催促、提供报错/截图文字、回答你之前的追问),调用 add_to_ticket 把内容同步给人工客服,然后简短回执「已把你的补充同步给人工,会一并跟进」,不要替人工承诺处理结果或时间。
- 若客户问的是**与该工单无关、且你依据知识库就能解答的新问题**,正常回答即可,不必调用 add_to_ticket。
- 若是**新的、需要人工**的问题(与原工单无关),用 create_support_ticket 另建工单。
- 若 add_to_ticket 返回 ticket_closed(原工单已关闭),改用 create_support_ticket 新建工单承接。`;
}
