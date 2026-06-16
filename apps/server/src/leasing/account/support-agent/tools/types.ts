import { ToolSchema } from "../llm/llm.types";

/** 工具执行上下文 —— customerId 由服务端从 JWT 注入,绝不取自模型。 */
export interface ToolContext {
  customerId: string;
}

/** 一个 agent 工具:对外的 schema + 服务端 handler。 */
export interface AgentTool {
  schema: ToolSchema;
  /** args 为模型给的参数(已 JSON.parse,可能字段缺失);ctx 含可信 customerId。 */
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/**
 * 工具依赖的服务(结构化接口,便于单测注入假实现)。
 * 这些方法均已是「客户自助」语义,返回值本身已脱敏(无 backingKeyValue/config)。
 */
export interface ToolDeps {
  profile: {
    getProfile(customerId: string): Promise<{
      email: string;
      displayName: string | null;
      creditCents: number;
      emailVerified: boolean;
      status: string;
    }>;
  };
  billing: {
    listSubscriptions(customerId: string): Promise<{ subscriptions: unknown[] }>;
    listOrders(
      customerId: string,
      page: number,
      pageSize: number,
    ): Promise<{ orders: unknown[]; total: number }>;
  };
  tickets: {
    create(
      customerId: string,
      subject: string,
      body: string,
    ): Promise<{ ticket: { id: string; status: string } }>;
  };
}

/** 工具结果序列化为 tool 消息前的体积上限(字符),防止撑爆上下文。 */
export const TOOL_RESULT_MAX_CHARS = 4000;
