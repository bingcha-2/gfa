import { Injectable } from "@nestjs/common";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { loadSupportLlmConfig, SupportLlmConfig } from "./llm.config";
import {
  ChatMessage,
  LlmStreamEvent,
  LlmToolCall,
  ToolSchema,
} from "./llm.types";

/**
 * LlmClient —— openai SDK 的薄封装,指向 env 配置的 OpenAI 兼容端点。
 *
 * 只暴露一个流式方法 `streamChat`:逐字 yield delta,最后 yield 一次 final
 * (含完整文本 + 累积好的 tool_calls)。tool_calls 在流式分片里是拆开来的,
 * 这里负责按 index 拼回完整调用。
 */
@Injectable()
export class LlmClient {
  private readonly config: SupportLlmConfig;
  private client: OpenAI | null = null;

  constructor(config?: SupportLlmConfig) {
    this.config = config ?? loadSupportLlmConfig();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get maxToolIters(): number {
    return this.config.maxToolIters;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        baseURL: this.config.baseUrl,
        apiKey: this.config.apiKey,
      });
    }
    return this.client;
  }

  /**
   * 流式跑一轮对话。yield:
   *   { type: "delta", text }     —— 助手文本增量
   *   { type: "final", content, toolCalls } —— 本轮结束汇总
   */
  async *streamChat(
    messages: ChatMessage[],
    tools: ToolSchema[],
  ): AsyncGenerator<LlmStreamEvent> {
    const client = this.getClient();
    const stream = await client.chat.completions.create({
      model: this.config.model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.length ? tools.map(toOpenAiTool) : undefined,
      stream: true,
    });

    let content = "";
    // index → 累积中的 tool call 片段
    const toolAcc = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        yield { type: "delta", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }))
      // 丢掉没拿到名字的残片(防御异常分片)
      .filter((c) => c.name.length > 0);

    yield { type: "final", content, toolCalls };
  }

  /**
   * 非流式补全 —— 给知识提炼 / 合并用(要的是一段完整文本,不需要流式)。
   * 返回助手文本(可能为空字符串)。
   */
  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await this.getClient().chat.completions.create({
      model: this.config.model,
      messages: messages.map(toOpenAiMessage),
      stream: false,
    });
    return res.choices[0]?.message?.content ?? "";
  }
}

// ── openai 类型映射 ──────────────────────────────────────────────────────────

function toOpenAiMessage(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
      tool_call_id: m.toolCallId ?? "",
    };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  if (m.role === "assistant") {
    return { role: "assistant", content: m.content };
  }
  if (m.role === "system") {
    return { role: "system", content: m.content };
  }
  return { role: "user", content: m.content };
}

function toOpenAiTool(t: ToolSchema): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}
