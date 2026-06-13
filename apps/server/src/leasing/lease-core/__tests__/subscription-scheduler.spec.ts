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
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 10 }],
      () => ({ allowed: true }),
    );
    const sched = new SubscriptionScheduler(store, null);
    expect(sched.selectForFailover(opts)?.id).toBe("s1");
  });

  it("s1 桶满 → 接力到 s2", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 10 }],
      (rec) => ({ allowed: rec.id !== "s1", resetMs: 5000 }),
    );
    const sched = new SubscriptionScheduler(store, null);
    expect(sched.selectForFailover(opts)?.id).toBe("s2");
  });

  it("全部桶满 → null", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 10 }],
      () => ({ allowed: false, resetMs: 5000 }),
    );
    expect(new SubscriptionScheduler(store, null).selectForFailover(opts)).toBeNull();
  });

  it("fair-share 拦截 s1 → 接力到 s2(各订阅用各自 boundAccountId)", () => {
    const store = makeStore(
      [{ id: "s1", customerId: "c1", boundAccountId: 10 }, { id: "s2", customerId: "c1", boundAccountId: 20 }],
      () => ({ allowed: true }),
    );
    const tracker = { checkFairShare: (acc: number, card: string) => ({ allowed: card !== "s1" }) } as any;
    const sched = new SubscriptionScheduler(store, tracker);
    expect(sched.selectForFailover(opts)?.id).toBe("s2");
  });
});
