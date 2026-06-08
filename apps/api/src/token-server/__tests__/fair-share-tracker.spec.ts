import { QUOTA_WEIGHTS as SHARED_WEIGHTS } from "@gfa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FairShareTracker } from "../fair-share-tracker";

// weightedCost 约定:input 为 gross(含 cached,经 normalizeUsageToGross 归一),
// 故内部取 netInput = max(0, input - cached) 再加权,避免缓存被双算。
// 权重:gemini {in 1.0, out 4.0, cache 0.25} / claude {1.0, 5.0, 0.10} / gpt {1.0, 3.0, 0.0}
describe("FairShareTracker.weightedCost (netInput)", () => {
  it("gemini: 缓存不再被 input+cache 双算(取真实定价比值)", () => {
    // gross input 180(含 80 cached), output 20, cached 80;权重 {in1,out6,cache0.25}(Gemini 真实 $2/$12)
    // netInput=100 → 100*1 + 20*6 + 80*0.25 = 240
    expect(FairShareTracker.weightedCost("antigravity-gemini", 180, 20, 80)).toBeCloseTo(240, 5);
  });

  it("gpt/codex: 输出 8×、缓存 0.10(真实定价比值)", () => {
    // gross input 17056(含 16000 cached), output 28;权重 {in1,out8,cache0.10}
    // netInput=1056 → 1056*1 + 28*8 + 16000*0.10 = 2880
    expect(FairShareTracker.weightedCost("codex-gpt", 17056, 28, 16000)).toBeCloseTo(2880, 5);
  });

  it("claude: 输出 5×、cache_read 0.10(不变)", () => {
    // netInput=150 → 150*1 + 10*5 + 80*0.10 = 208
    expect(FairShareTracker.weightedCost("anthropic-claude", 230, 10, 80)).toBeCloseTo(208, 5);
  });

  it("cached>input 防御:netInput 夹到 0", () => {
    // 50*? 不应为负;netInput=max(0,50-80)=0 → 0 + 0 + 80*0.25 = 20
    expect(FairShareTracker.weightedCost("antigravity-gemini", 50, 0, 80)).toBe(20);
  });

  it("加权用量可大于原始 token:输出按权重放大(by design,非 bug)", () => {
    // 卡表「本窗口已用(加权)」可能 > 「近期 Token(原始)」,因为输出 token 贵、
    // 被乘了权重。固化这个反直觉但正确的行为(用户曾困惑「累计怎么小于已用」)。
    // 真实样本 card_mq3kzlwb:input=42136(gross,无 cache)/ output=264 / cache=0。
    const weighted = FairShareTracker.weightedCost("anthropic-claude", 42136, 264, 0);
    const rawBillable = 42136 + 264; // 原始计费 token(无缓存)= 42400
    expect(weighted).toBeCloseTo(43456, 5); // 42136×1 + 264×5
    expect(weighted).toBeGreaterThan(rawBillable); // 43.46K(加权) > 42.40K(原始)
  });
});

// ── SQL 持久化(FairShareWindow):内存聚合 + 定时批量整池替换 + 启动 load ──────────
const WINDOW_MS = 5 * 60 * 60 * 1000;

function makeFsPrisma() {
  const store = new Map<string, any>(); // key: provider|accountId|bucket|cardId
  const fairShareWindow = {
    deleteMany: vi.fn(async ({ where }: any) => {
      let count = 0;
      for (const [k, v] of [...store]) {
        if (v.provider === where.provider) { store.delete(k); count++; }
      }
      return { count };
    }),
    createMany: vi.fn(async ({ data }: any) => {
      for (const row of data) {
        store.set(`${row.provider}|${row.accountId}|${row.bucket}|${row.cardId}`, { ...row });
      }
      return { count: data.length };
    }),
    findMany: vi.fn(async ({ where }: any) =>
      [...store.values()].filter((v) => v.provider === where.provider).map((v) => ({ ...v }))),
  };
  const prisma = { fairShareWindow, $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)) };
  return { prisma, store, fairShareWindow };
}

function makeTracker(now: () => number, prisma?: any) {
  return new FairShareTracker({
    getAccountPlanType: () => "pro",
    getBoundCardIds: () => [],
    getCardWeight: () => 1,
    accountShareCapacity: 8,
    provider: "codex",
    prisma,
    now,
  });
}

const trackers: FairShareTracker[] = [];
afterEach(() => {
  while (trackers.length) trackers.pop()?.destroy();
});
function track(t: FairShareTracker): FairShareTracker {
  trackers.push(t);
  return t;
}

describe("FairShareTracker SQL persistence", () => {
  it("round-trips per-card usage across a restart (same window)", async () => {
    const { prisma } = makeFsPrisma();
    const T = 1_700_000_000_000;
    const t1 = track(makeTracker(() => T, prisma));
    t1.recordUsage(1, "c1", "codex-gpt", 17056, 28, 16000); // cost 2880(gpt cache 0.10)
    t1.recordUsage(1, "c2", "codex-gpt", 100, 0, 0); // cost 100
    expect(t1.getTrackerState(1, "codex-gpt")?.totalUsed).toBe(2980);
    await t1.flush();

    const t2 = track(makeTracker(() => T, prisma));
    await t2.load();
    expect(t2.getTrackerState(1, "codex-gpt")?.totalUsed).toBe(2980);
    expect(t2.getBucketStateForTesting(1, "codex-gpt")?.perCard.c1).toBe(2880);
  });

  it("on load past the 5h boundary: discards usage but keeps the learned budget", async () => {
    const { prisma } = makeFsPrisma();
    const T = 1_700_000_000_000;
    const t1 = track(makeTracker(() => T, prisma));
    t1.recordUsage(1, "c1", "codex-gpt", 100100, 0, 0); // cost 100100
    t1.confirmBudget(1, "codex-gpt"); // estimatedBudget = totalUsed, confidence 'confirmed'
    await t1.flush();

    const t2 = track(makeTracker(() => T + WINDOW_MS + 1, prisma)); // window expired
    await t2.load();
    const state = t2.getBucketStateForTesting(1, "codex-gpt");
    expect(state?.totalUsed).toBe(0); // stale per-card usage discarded
    expect(state?.estimatedBudget).toBe(100100); // budget retained
    expect(state?.confidence).toBe("estimated"); // confirmed downgraded
    expect(state?.lastFraction).toBe(1); // upstream window reset → full
  });

  it("flush is a no-op until state changes again (dirty gate)", async () => {
    const { prisma, fairShareWindow } = makeFsPrisma();
    const T = 1_700_000_000_000;
    const t1 = track(makeTracker(() => T, prisma));
    t1.recordUsage(1, "c1", "codex-gpt", 100, 0, 0);
    await t1.flush();
    expect(fairShareWindow.deleteMany).toHaveBeenCalledTimes(1);
    await t1.flush(); // nothing changed
    expect(fairShareWindow.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("wholesale-replaces rows so a rolled-over window leaves no stale card", async () => {
    const { prisma, store } = makeFsPrisma();
    const T = 1_700_000_000_000;
    const t1 = track(makeTracker(() => T, prisma));
    t1.recordUsage(1, "c1", "codex-gpt", 100, 0, 0);
    t1.recordUsage(1, "c2", "codex-gpt", 100, 0, 0);
    await t1.flush();
    expect(store.size).toBe(2);

    // Upstream reset rolls the window forward → perCard cleared.
    t1.syncWindow(1, "codex-gpt", T + 10 * 60 * 1000 + WINDOW_MS);
    t1.recordUsage(1, "c1", "codex-gpt", 50, 0, 0); // only c1 active now
    await t1.flush();
    expect(store.size).toBe(1);
    expect([...store.values()][0].cardId).toBe("c1");
  });

  it("no-ops gracefully without a prisma client", async () => {
    const t = track(makeTracker(() => 1_700_000_000_000));
    t.recordUsage(1, "c1", "codex-gpt", 100, 0, 0);
    await expect(t.flush()).resolves.toBeUndefined();
    await expect(t.load()).resolves.toBeUndefined();
    expect(t.getTrackerState(1, "codex-gpt")?.totalUsed).toBe(100);
  });
});

describe("FairShareTracker.getCardWindowUsed", () => {
  it("sums a card's weighted usage across buckets in the current window", () => {
    const t = new FairShareTracker({
      getAccountPlanType: () => "pro", getBoundCardIds: () => [], getCardWeight: () => 1,
      accountShareCapacity: 8, now: () => 1_700_000_000_000,
    });
    t.recordUsage(1, "c1", "codex-gpt", 100, 0, 0); // 100
    t.recordUsage(1, "c1", "anthropic-claude", 0, 10, 0); // 10*5=50
    expect(t.getCardWindowUsed(1, "c1")).toBeCloseTo(150, 5);
    expect(t.getCardWindowUsed(1, "absent")).toBe(0);
  });
});

describe("QUOTA_WEIGHTS 派生自定价源", () => {
  it("claude 5/0.10、gemini 6/0.25、gpt 8/0.10(真实当代定价派生)", () => {
    expect(SHARED_WEIGHTS.claude.output).toBe(5);
    expect(SHARED_WEIGHTS.claude.cache).toBeCloseTo(0.1, 5);
    expect(SHARED_WEIGHTS.gemini.output).toBe(6);
    expect(SHARED_WEIGHTS.gemini.cache).toBeCloseTo(0.25, 5);
    expect(SHARED_WEIGHTS.gpt.output).toBe(8);
    expect(SHARED_WEIGHTS.gpt.cache).toBeCloseTo(0.1, 5);
  });
});
