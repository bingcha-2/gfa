/**
 * 客服 agent 与 LLM 之间的薄类型层。
 *
 * 故意不直接暴露 openai SDK 的类型给 agent / 工具层,这样:
 *   - agent 逻辑与具体 SDK 解耦,便于测试(mock LlmClient)
 *   - 将来换 embedding / 供应商时,改 llm.client 即可,接口不动
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 一条对话消息(送给模型 / 从模型来)。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息发起的工具调用。 */
  toolCalls?: LlmToolCall[];
  /** tool 消息:对应的 tool_call id。 */
  toolCallId?: string;
  /** tool 消息:工具名(便于审计 / 落库)。 */
  name?: string;
}

/** 模型发起的一次工具调用。 */
export interface LlmToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串参数(可能不合法,执行前需 try-parse)。 */
  arguments: string;
}

/** 工具定义(OpenAI function-calling 的 function 部分)。 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 对象。 */
  parameters: Record<string, unknown>;
}

/** 流式事件:逐字增量,或一轮结束的汇总。 */
export type LlmStreamEvent =
  | { type: "delta"; text: string }
  | { type: "final"; content: string; toolCalls: LlmToolCall[] };
