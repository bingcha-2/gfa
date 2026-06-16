/**
 * support-agent.service.spec.ts — agent 工具循环编排
 *
 * 覆盖:
 *   1. 禁用 → 单个 error 事件
 *   2. 直接回答(无工具)→ meta/delta/done,落库终答
 *   3. 调一次工具再答 → tool 事件 + 工具执行 + 终答
 *   4. 升级建工单 → done.ticketId + markEscalated
 *   5. LLM 抛错 → 兜底 delta + done,不抛
 *   6. 跑满轮数仍调工具 → 兜底
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { SupportAgentService } from "../support-agent.service";
import { LlmToolCall } from "../llm/llm.types";
import { SseEvent } from "../support-agent.types";

interface Turn {
  deltas?: string[];
  toolCalls?: LlmToolCall[];
  throw?: boolean;
}

function makeLlm(turns: Turn[], opts: { enabled?: boolean; maxToolIters?: number } = {}) {
  let i = 0;
  return {
    enabled: opts.enabled ?? true,
    maxToolIters: opts.maxToolIters ?? 6,
    async *streamChat() {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      if (turn.throw) throw new Error("boom");
      for (const d of turn.deltas ?? []) yield { type: "delta" as const, text: d };
      yield {
        type: "final" as const,
        content: (turn.deltas ?? []).join(""),
        toolCalls: turn.toolCalls ?? [],
      };
    },
  };
}

function makeDeps() {
  const conversations = {
    resolve: vi.fn().mockResolvedValue({ id: "c1" }),
    appendUserMessage: vi.fn().mockResolvedValue(undefined),
    appendAssistantMessage: vi.fn().mockResolvedValue(undefined),
    appendToolMessage: vi.fn().mockResolvedValue(undefined),
    getRecentDialogue: vi.fn().mockResolvedValue([]),
    markEscalated: vi.fn().mockResolvedValue(undefined),
    countUserMessagesSince: vi.fn().mockResolvedValue(0),
  };
  const customerAuth = {
    getProfile: vi.fn().mockResolvedValue({
      email: "me@test.com", displayName: "Me", creditCents: 0,
      emailVerified: true, status: "ACTIVE",
    }),
  };
  const billing = {
    listSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    listOrders: vi.fn().mockResolvedValue({ orders: [], total: 0 }),
  };
  const knowledge = {
    // 「全塞」模式:agent 启动时载入全部已发布 Q&A 拼进系统提示词。
    listPublishedQA: vi.fn().mockResolvedValue([]),
  };
  const tickets = {
    create: vi.fn().mockResolvedValue({ ticket: { id: "t9", status: "OPEN" } }),
    reply: vi.fn().mockResolvedValue({ message: { id: "m1" } }),
  };
  return { conversations, customerAuth, billing, knowledge, tickets };
}

function build(llm: any, deps: ReturnType<typeof makeDeps>) {
  return new SupportAgentService(
    llm,
    deps.conversations as any,
    deps.knowledge as any,
    deps.tickets as any,
    deps.customerAuth as any,
    deps.billing as any,
  );
}

async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const CTX = { customerId: "cust-real" };
const toolCall = (name: string, args: object): LlmToolCall => ({
  id: "1", name, arguments: JSON.stringify(args),
});

describe("SupportAgentService.run", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => { deps = makeDeps(); });

  it("禁用 → 单个 error", async () => {
    const svc = build(makeLlm([], { enabled: false }), deps);
    const ev = await collect(svc.run(CTX, undefined, "你好"));
    expect(ev).toEqual([{ type: "error", message: expect.any(String) }]);
    expect(deps.conversations.resolve).not.toHaveBeenCalled();
  });

  it("超过每分钟上限 → 限流 error,不调模型", async () => {
    deps.conversations.countUserMessagesSince
      .mockResolvedValueOnce(10) // perMin 达上限(默认 10)
      .mockResolvedValueOnce(10);
    const llm = makeLlm([{ deltas: ["不该被调用"] }]);
    const svc = build(llm, deps);
    const ev = await collect(svc.run(CTX, undefined, "刷刷刷"));
    expect(ev).toEqual([{ type: "error", message: expect.any(String) }]);
    expect(deps.conversations.resolve).not.toHaveBeenCalled();
    expect(deps.conversations.appendUserMessage).not.toHaveBeenCalled();
  });

  it("超过每日上限 → 限流 error", async () => {
    deps.conversations.countUserMessagesSince
      .mockResolvedValueOnce(0) // perMin ok
      .mockResolvedValueOnce(50); // perDay 达上限(默认 50)
    const svc = build(makeLlm([{ deltas: ["x"] }]), deps);
    const ev = await collect(svc.run(CTX, undefined, "今天问太多了"));
    expect(ev).toEqual([{ type: "error", message: expect.any(String) }]);
  });

  it("直接回答 → meta/delta/done,落库终答", async () => {
    const svc = build(makeLlm([{ deltas: ["你好", "!"] }]), deps);
    const ev = await collect(svc.run(CTX, undefined, "在吗"));
    expect(ev[0]).toEqual({ type: "meta", conversationId: "c1" });
    expect(ev.filter((e) => e.type === "delta")).toEqual([
      { type: "delta", text: "你好" },
      { type: "delta", text: "!" },
    ]);
    expect(ev.at(-1)).toEqual({ type: "done", conversationId: "c1", ticketId: null });
    expect(deps.conversations.appendUserMessage).toHaveBeenCalledWith("c1", "在吗");
    expect(deps.conversations.appendAssistantMessage).toHaveBeenLastCalledWith("c1", "你好!");
  });

  it("调一次工具再答", async () => {
    const llm = makeLlm([
      { toolCalls: [toolCall("get_my_subscriptions", {})] },
      { deltas: ["你的订阅有效"] },
    ]);
    const svc = build(llm, deps);
    const ev = await collect(svc.run(CTX, undefined, "我的订阅状态?"));
    expect(ev).toContainEqual({ type: "tool", name: "get_my_subscriptions" });
    expect(deps.billing.listSubscriptions).toHaveBeenCalledWith("cust-real");
    expect(deps.conversations.appendToolMessage).toHaveBeenCalledWith(
      "c1", "get_my_subscriptions", expect.any(String),
    );
    expect(ev).toContainEqual({ type: "delta", text: "你的订阅有效" });
    expect(ev.at(-1)).toEqual({ type: "done", conversationId: "c1", ticketId: null });
  });

  it("升级建工单 → done.ticketId + markEscalated", async () => {
    const llm = makeLlm([
      { toolCalls: [toolCall("create_support_ticket", { subject: "退款", body: "要退款" })] },
      { deltas: ["已为你转人工"] },
    ]);
    const svc = build(llm, deps);
    const ev = await collect(svc.run(CTX, undefined, "我要退款"));
    expect(deps.tickets.create).toHaveBeenCalledWith("cust-real", "退款", "要退款");
    expect(deps.conversations.markEscalated).toHaveBeenCalledWith("c1", "t9");
    expect(ev.at(-1)).toEqual({ type: "done", conversationId: "c1", ticketId: "t9" });
  });

  it("LLM 抛错 → 兜底 delta + done,不抛", async () => {
    const svc = build(makeLlm([{ throw: true }]), deps);
    const ev = await collect(svc.run(CTX, undefined, "你好"));
    const deltas = ev.filter((e) => e.type === "delta");
    expect(deltas.length).toBe(1);
    expect(ev.at(-1)?.type).toBe("done");
    expect(deps.conversations.appendAssistantMessage).toHaveBeenCalled();
  });

  it("跑满轮数仍调工具 → 兜底", async () => {
    const llm = makeLlm(
      [{ toolCalls: [toolCall("get_my_orders", {})] }],
      { maxToolIters: 2 },
    );
    const svc = build(llm, deps);
    const ev = await collect(svc.run(CTX, undefined, "绕圈"));
    expect(ev.filter((e) => e.type === "tool").length).toBe(2);
    // 兜底文案作为最后的 delta
    expect(ev.filter((e) => e.type === "delta").length).toBe(1);
    expect(ev.at(-1)?.type).toBe("done");
  });

  it("已转人工会话:bot 调 add_to_ticket 把补充同步进工单", async () => {
    deps.conversations.resolve.mockResolvedValueOnce({ id: "c1", ticketId: "t1" });
    const llm = makeLlm([
      { toolCalls: [toolCall("add_to_ticket", { note: "我换了网络还是不行" })] },
      { deltas: ["已把你的补充同步给人工"] },
    ]);
    const svc = build(llm, deps);
    const ev = await collect(svc.run(CTX, "c1", "补充:我换了网络还是不行"));
    expect(ev).toContainEqual({ type: "tool", name: "add_to_ticket" });
    expect(deps.tickets.reply).toHaveBeenCalledWith("cust-real", "t1", "我换了网络还是不行");
    // 沿用原工单,不重复 markEscalated
    expect(deps.conversations.markEscalated).not.toHaveBeenCalled();
    expect(ev.at(-1)).toEqual({ type: "done", conversationId: "c1", ticketId: "t1" });
  });

  it("已转人工会话:bot 判断为可答的新问题 → 直接答,不碰工单", async () => {
    deps.conversations.resolve.mockResolvedValueOnce({ id: "c1", ticketId: "t1" });
    const svc = build(makeLlm([{ deltas: ["这个问题这样解决…"] }]), deps);
    const ev = await collect(svc.run(CTX, "c1", "顺便问下怎么改昵称?"));
    expect(deps.tickets.reply).not.toHaveBeenCalled();
    expect(ev).toContainEqual({ type: "delta", text: "这个问题这样解决…" });
    expect(ev.at(-1)).toEqual({ type: "done", conversationId: "c1", ticketId: "t1" });
  });

  it("会话归属 403 → error 事件,不抛", async () => {
    const { ForbiddenException } = await import("@nestjs/common");
    deps.conversations.resolve.mockRejectedValueOnce(new ForbiddenException());
    const svc = build(makeLlm([{ deltas: ["hi"] }]), deps);
    const ev = await collect(svc.run(CTX, "other-conv", "你好"));
    expect(ev).toEqual([{ type: "error", message: expect.any(String) }]);
  });
});
