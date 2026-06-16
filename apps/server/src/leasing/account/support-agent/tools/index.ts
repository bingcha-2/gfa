import { ToolSchema } from "../llm/llm.types";
import { AgentTool, ToolDeps } from "./types";

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

/**
 * 构建本次会话可用的工具表(name → AgentTool)。
 * 所有 handler 一律用 ctx.customerId 取数,忽略模型可能塞进 args 的任何 id。
 */
export function buildTools(deps: ToolDeps): Map<string, AgentTool> {
  const tools: AgentTool[] = [
    {
      schema: {
        name: "get_my_profile",
        description:
          "查询当前登录客户本人的账户资料:邮箱、昵称、余额、邮箱是否验证、账户状态。回答与账户/余额相关问题前先调用。",
        parameters: NO_ARGS,
      },
      handler: async (_args, ctx) => {
        const p = await deps.profile.getProfile(ctx.customerId);
        return {
          email: p.email,
          displayName: p.displayName,
          balanceCents: p.creditCents,
          balanceYuan: (p.creditCents / 100).toFixed(2),
          emailVerified: p.emailVerified,
          status: p.status,
        };
      },
    },
    {
      schema: {
        name: "get_my_subscriptions",
        description:
          "查询当前客户本人的订阅列表(套餐、状态、到期时间、设备数限制)。回答订阅是否生效/何时到期等问题前调用。",
        parameters: NO_ARGS,
      },
      handler: async (_args, ctx) => {
        const { subscriptions } = await deps.billing.listSubscriptions(
          ctx.customerId,
        );
        return { subscriptions };
      },
    },
    {
      schema: {
        name: "get_my_orders",
        description:
          "查询当前客户本人的订单(购买记录:套餐名、金额、支付渠道、状态、下单/支付时间)。回答付款/订单状态问题前调用。",
        parameters: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, description: "页码,默认 1" },
            pageSize: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "每页数量,默认 10,最大 20",
            },
          },
          additionalProperties: false,
        },
      },
      handler: async (args, ctx) => {
        const page = toPosInt(args.page, 1);
        const pageSize = Math.min(toPosInt(args.pageSize, 10), 20);
        const { orders, total } = await deps.billing.listOrders(
          ctx.customerId,
          page,
          pageSize,
        );
        return { orders, total, page, pageSize };
      },
    },
    {
      schema: {
        name: "create_support_ticket",
        description:
          "当你无法解答、或问题涉及退款/账号安全/客户明确要求人工时,创建工单转人工客服。创建后告知客户工单已提交。",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", description: "工单标题(简短,≤120 字)" },
            body: {
              type: "string",
              description:
                "问题描述,概括客户诉求与已了解的信息;若客户提供了报错原文或日志,原样附上(太长则截取最相关段落)(≤4000 字)",
            },
          },
          required: ["subject", "body"],
          additionalProperties: false,
        },
      },
      handler: async (args, ctx) => {
        const subject = clamp(asString(args.subject) || "客服咨询", 120);
        const body = clamp(asString(args.body) || "(无描述)", 4000);
        const { ticket } = await deps.tickets.create(
          ctx.customerId,
          subject,
          body,
        );
        return { ticketId: ticket.id, status: ticket.status };
      },
    },
  ];

  return new Map(tools.map((t) => [t.schema.name, t]));
}

/** 抽出工具 schema 列表(传给 LLM)。 */
export function toolSchemas(tools: Map<string, AgentTool>): ToolSchema[] {
  return [...tools.values()].map((t) => t.schema);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toPosInt(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
