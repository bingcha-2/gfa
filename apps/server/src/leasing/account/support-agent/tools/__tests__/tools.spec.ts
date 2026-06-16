/**
 * tools.spec.ts — agent 工具集
 *
 * 重点:数据隔离(一律用 ctx.customerId,忽略模型塞进 args 的 id)、
 * 参数夹取、建工单。(知识走「全塞」提示词,无检索工具)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { buildTools, toolSchemas } from "../index";
import { ToolDeps } from "../types";

function makeDeps() {
  return {
    profile: {
      getProfile: vi.fn().mockResolvedValue({
        email: "me@test.com",
        displayName: "Me",
        creditCents: 1234,
        emailVerified: true,
        status: "ACTIVE",
      }),
    },
    billing: {
      listSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [{ id: "s1" }] }),
      listOrders: vi.fn().mockResolvedValue({ orders: [{ outTradeNo: "o1" }], total: 1 }),
    },
    tickets: {
      create: vi.fn().mockResolvedValue({ ticket: { id: "t1", status: "OPEN" } }),
    },
  } satisfies ToolDeps & Record<string, any>;
}

const CTX = { customerId: "cust-real" };

describe("agent tools", () => {
  let deps: ReturnType<typeof makeDeps>;
  let tools: ReturnType<typeof buildTools>;

  beforeEach(() => {
    deps = makeDeps();
    tools = buildTools(deps);
  });

  it("注册了 4 个工具,schema 名字齐全(无知识检索工具)", () => {
    expect(toolSchemas(tools).map((s) => s.name).sort()).toEqual(
      [
        "create_support_ticket",
        "get_my_orders",
        "get_my_profile",
        "get_my_subscriptions",
      ].sort(),
    );
  });

  it("get_my_profile 用 ctx.customerId,返回余额", async () => {
    const out: any = await tools.get("get_my_profile")!.handler({}, CTX);
    expect(deps.profile.getProfile).toHaveBeenCalledWith("cust-real");
    expect(out.balanceCents).toBe(1234);
    expect(out.balanceYuan).toBe("12.34");
  });

  it("数据隔离:即便 args 带别人 customerId 也忽略", async () => {
    await tools.get("get_my_subscriptions")!.handler(
      { customerId: "attacker" } as any,
      CTX,
    );
    expect(deps.billing.listSubscriptions).toHaveBeenCalledWith("cust-real");
    expect(deps.billing.listSubscriptions).not.toHaveBeenCalledWith("attacker");
  });

  it("get_my_orders 夹取 pageSize≤20,默认 page1/size10", async () => {
    await tools.get("get_my_orders")!.handler({ pageSize: 999 }, CTX);
    expect(deps.billing.listOrders).toHaveBeenCalledWith("cust-real", 1, 20);

    await tools.get("get_my_orders")!.handler({}, CTX);
    expect(deps.billing.listOrders).toHaveBeenCalledWith("cust-real", 1, 10);
  });

  it("create_support_ticket 用 ctx.customerId 并夹取标题长度", async () => {
    const longSubject = "标".repeat(200);
    const out: any = await tools
      .get("create_support_ticket")!
      .handler({ subject: longSubject, body: "帮我看看" }, CTX);
    expect(out).toEqual({ ticketId: "t1", status: "OPEN" });
    const [cid, subj, body] = deps.tickets.create.mock.calls[0];
    expect(cid).toBe("cust-real");
    expect(subj.length).toBe(120);
    expect(body).toBe("帮我看看");
  });
});
