import { describe, expect, it } from "vitest";
import { SubscriptionScheduler } from "../subscription-scheduler";

function makeStore(records: any[], precheck: (rec: any) => { allowed: boolean; resetMs?: number }) {
  return {
    listByCustomerSorted: (cid: string) => records.filter((r) => r.customerId === cid),
    precheckRecord: (rec: any) => precheck(rec),
    boundAccountIdFor: (rec: any) => Number(rec.boundAccountId || 0),
  } as any;
}

describe("SubscriptionScheduler — 优先级接力", () => {
  const opts = { customerId: "c1", providerId: "codex", modelKey: "gpt-5-codex", bucket: "codex-gpt", precheckOptions: {} as any };

  it("优先级最高的订阅有额度 → 直接选它", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10, products: ["codex"] }, { id: "s2", customerId: "c1", boundAccountId: 10, products: ["codex"] }],
      () => ({ allowed: true }),
    );
    const sched = new SubscriptionScheduler(store, null);
    expect(sched.selectForFailover(opts).picked?.id).toBe("s1");
  });

  it("s1 桶满 → 接力到 s2", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10, products: ["codex"] }, { id: "s2", customerId: "c1", boundAccountId: 10, products: ["codex"] }],
      (rec) => ({ allowed: rec.id !== "s1", resetMs: 5000 }),
    );
    const sched = new SubscriptionScheduler(store, null);
    expect(sched.selectForFailover(opts).picked?.id).toBe("s2");
  });

  it("全部桶满 → picked=null", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10, products: ["codex"] }, { id: "s2", customerId: "c1", boundAccountId: 10, products: ["codex"] }],
      () => ({ allowed: false, resetMs: 5000 }),
    );
    expect(new SubscriptionScheduler(store, null).selectForFailover(opts).picked).toBeNull();
  });

  it("fair-share 拦截 s1 → 接力到 s2(各订阅用各自 boundAccountId)", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10, products: ["codex"] }, { id: "s2", customerId: "c1", boundAccountId: 20, products: ["codex"] }],
      () => ({ allowed: true }),
    );
    const tracker = { checkFairShare: (acc: number, card: string) => ({ allowed: card !== "s1" }) } as any;
    const sched = new SubscriptionScheduler(store, tracker);
    expect(sched.selectForFailover(opts).picked?.id).toBe("s2");
  });

  it("跳过不服务该 provider 的订阅(产品过滤)", () => {
    const store = makeStore(
      [{ id: "s-codex", customerId: "c1", boundAccountId: 0, products: ["codex"] },
       { id: "s-anth", customerId: "c1", boundAccountId: 0, products: ["anthropic"] }],
      () => ({ allowed: true }),
    );
    // 请求 anthropic:应跳过只服务 codex 的 s-codex,选 s-anth
    const sched = new SubscriptionScheduler(store, null);
    const r = sched.selectForFailover({ customerId: "c1", providerId: "anthropic", modelKey: "claude-sonnet-4-6", bucket: "anthropic-claude", precheckOptions: {} as any });
    expect(r.picked?.id).toBe("s-anth");
  });
});
