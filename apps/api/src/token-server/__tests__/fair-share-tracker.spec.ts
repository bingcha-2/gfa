import { QUOTA_WEIGHTS as SHARED_WEIGHTS } from "@gfa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeModelTier } from "../../lease-core/product-bucket";
import { FairShareTracker, weeklyBucketKey } from "../fair-share-tracker";

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

  it("on load past the 5h boundary: discards usage; budget comes from the learned profile/default", async () => {
    const { prisma } = makeFsPrisma();
    const T = 1_700_000_000_000;
    const t1 = track(makeTracker(() => T, prisma));
    t1.recordUsage(1, "c1", "codex-gpt", 100100, 0, 0); // cost 100100
    await t1.flush();

    const t2 = track(makeTracker(() => T + WINDOW_MS + 1, prisma)); // window expired
    await t2.load();
    const state = t2.getBucketStateForTesting(1, "codex-gpt");
    expect(state?.totalUsed).toBe(0); // stale per-card usage discarded
    // Budget is no longer per-account ratcheted/persisted — it's read from the
    // learned profile (none wired here) → DEFAULT_BUDGETS.pro.gpt.
    expect(state?.resolvedBudget).toBe(100000);
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

// ── 按 Claude 模型档位计价(方案 A:成本加权单桶)──────────────────────────────
// 用线上真实上报的 modelKey 串做固件,确保版本/日期/-thinking 后缀、fable、自动补全
// 都被正确归档。weightedCost(input=100, output=10, cached=0) → net=100:
//   opus {1,5,0.1}=150 / sonnet {0.6,3,0.06}=90 / haiku {0.2,1,0.02}=30 /
//   fable {2,10,0.2}=300(恰为 Opus 2×) / autocomplete {0.02,0.08,..}=2.8
describe("claudeModelTier:线上真实上报串归档", () => {
  it.each([
    ["claude-opus-4-8", "opus"],
    ["claude-opus-4-6-thinking", "opus"], // -thinking 别名 → 仍按 opus(思考已计入 output)
    ["claude-fable-5", "fable"],
    ["claude-haiku-4-5-20251001", "haiku"], // 日期后缀忽略
    ["claude-opus-4-6", "opus"],
    ["claude-sonnet-4-6", "sonnet"],
    ["claude-opus-4-7", "opus"],
    ["tab_flash_lite_preview", "autocomplete"], // 自动补全,不再被当 Opus
    ["tab_jump_flash_lite_preview", "autocomplete"],
  ] as const)("%s → %s", (modelKey, tier) => {
    expect(claudeModelTier(modelKey)).toBe(tier);
  });

  it("未知 claude 别名兜底为 unknown(计价侧按 Opus)", () => {
    expect(claudeModelTier("claude-mystery-9")).toBe("unknown");
  });
});

describe("weightedCost:按 Claude 档位单价", () => {
  it.each([
    ["claude-opus-4-8", 150],
    ["claude-opus-4-6-thinking", 150], // 深度模式不额外加价(输出已含思考)
    ["claude-opus-4-6", 150],
    ["claude-opus-4-7", 150],
    ["claude-sonnet-4-6", 90],
    ["claude-haiku-4-5-20251001", 30],
    ["claude-fable-5", 300], // 恰为 Opus 的 2×
    ["tab_flash_lite_preview", 2.8],
    ["tab_jump_flash_lite_preview", 2.8],
  ] as const)("%s → %d", (modelKey, expected) => {
    expect(FairShareTracker.weightedCost(modelKey, 100, 10, 0)).toBeCloseTo(expected, 5);
  });

  it("fable 恒为同口径 opus 的 2×(含 input/output/cache)", () => {
    const opus = FairShareTracker.weightedCost("claude-opus-4-8", 500, 120, 200);
    const fable = FairShareTracker.weightedCost("claude-fable-5", 500, 120, 200);
    expect(fable).toBeCloseTo(opus * 2, 5);
  });

  it("未知 claude 别名按 Opus 计(与历史 anthropic-claude 桶一致)", () => {
    const unknown = FairShareTracker.weightedCost("claude-mystery-9", 230, 10, 80);
    const legacyBucket = FairShareTracker.weightedCost("anthropic-claude", 230, 10, 80);
    expect(unknown).toBeCloseTo(legacyBucket, 5);
    expect(unknown).toBeCloseTo(208, 5);
  });
});

describe("recordUsage:按 modelKey 计权,同账号 Claude 共享一个桶", () => {
  it("传 modelKey 时按档位计价;Opus 比 Haiku 多扣份额", () => {
    const t = new FairShareTracker({
      getAccountPlanType: () => "max", getBoundCardIds: () => [], getCardWeight: () => 1,
      accountShareCapacity: 8, now: () => 1_700_000_000_000,
    });
    // 同一个 anthropic-claude 桶,不同模型 → 不同加权成本
    t.recordUsage(1, "opusCard", "anthropic-claude", 100, 10, 0, "claude-opus-4-8");   // 150
    t.recordUsage(1, "haikuCard", "anthropic-claude", 100, 10, 0, "claude-haiku-4-5"); // 30
    const st = t.getBucketStateForTesting(1, "anthropic-claude");
    expect(st?.perCard.opusCard).toBeCloseTo(150, 5);
    expect(st?.perCard.haikuCard).toBeCloseTo(30, 5);
    expect(st?.totalUsed).toBeCloseTo(180, 5);
  });
});

// ── 阶段 2:自动补全不计额度 + 5h/周双窗口公平份额 ────────────────────────────
function makeClaudeTracker(now: () => number, trackWeekly: boolean) {
  return new FairShareTracker({
    getAccountPlanType: () => "max", getBoundCardIds: () => [], getCardWeight: () => 1,
    accountShareCapacity: 8, trackWeekly, now,
  });
}

describe("自动补全(tab_*/flash_lite)不消耗额度", () => {
  it("autocomplete 档不记入任何窗口,也不创建 tracker", () => {
    const t = makeClaudeTracker(() => 1_700_000_000_000, true);
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "tab_flash_lite_preview");
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "tab_jump_flash_lite_preview");
    expect(t.getCardWindowUsed(1, "c1")).toBe(0);
    expect(t.getBucketStateForTesting(1, "anthropic-claude")).toBeNull();
    expect(t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))).toBeNull();
    // 正常模型仍照常计入
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "claude-opus-4-8");
    expect(t.getBucketStateForTesting(1, "anthropic-claude")?.perCard.c1).toBeCloseTo(150, 5);
  });
});

describe("周窗口公平份额(trackWeekly)", () => {
  const T = 1_700_000_000_000;
  const FIVE_H = 5 * 60 * 60 * 1000;

  it("每笔成本同时累计到 5h 与周两个独立窗口", () => {
    const t = makeClaudeTracker(() => T, true);
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "claude-opus-4-8"); // 150
    expect(t.getBucketStateForTesting(1, "anthropic-claude")?.perCard.c1).toBeCloseTo(150, 5);
    expect(t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))?.perCard.c1).toBeCloseTo(150, 5);
  });

  it("跨 5h 边界:5h 窗口归零,周窗口累计保留", () => {
    let now = T;
    const t = makeClaudeTracker(() => now, true);
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "claude-opus-4-8"); // 150 / 150
    now = T + FIVE_H + 1; // 过 5h
    t.recordUsage(1, "c1", "anthropic-claude", 0, 2, 0, "claude-opus-4-8"); // +10:5h 重置后=10,周=160
    expect(t.getBucketStateForTesting(1, "anthropic-claude")?.perCard.c1).toBeCloseTo(10, 5);
    expect(t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))?.perCard.c1).toBeCloseTo(160, 5);
    // getCardWindowUsed 只统计 5h,不与周双算
    expect(t.getCardWindowUsed(1, "c1")).toBeCloseTo(10, 5);
  });

  it("周份额用完即拦,即便 5h 窗口仍宽松(reason 标注本周)", () => {
    const t = makeClaudeTracker(() => T, true);
    t.recordUsage(1, "c1", "anthropic-claude", 1_500_000, 0, 0, "claude-opus-4-8");
    t.updateWeeklyBudgetEstimate(1, "anthropic-claude", 0.5);
    const r = t.checkFairShare(1, "c1", "anthropic-claude");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("本周");
    expect(r.window).toBe("7d");
    expect(r.bucket).toBe("anthropic-claude");
    expect(r.resetAt).toBe(T + 7 * 24 * 60 * 60 * 1000);
    expect(r.retryAfterMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("weekly budget floors at default5h × R while weekly is unlearned", () => {
    const t = makeClaudeTracker(() => T, true);
    t.recordUsage(1, "c1", "anthropic-claude", 20_000, 0, 0, "claude-opus-4-8"); // creates 5h + weekly trackers
    const shortBudget = t.getBucketStateForTesting(1, "anthropic-claude")!.resolvedBudget;
    const weekly = t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))!;
    // No learned weekly → weekly budget = max(default5h, learned5h) × clamp(R) ≥ short × 4.235.
    expect(weekly.resolvedBudget).toBeGreaterThanOrEqual(shortBudget * 4.235);
    expect(t.checkFairShare(1, "c1", "anthropic-claude").allowed).toBe(true);
  });
});

describe("getCardWeeklyQuotaFractions(周血条)", () => {
  const T = 1_700_000_000_000;

  it("返回周窗口 fraction,键为基础桶名;5h 接口仍不含周键", () => {
    const t = makeClaudeTracker(() => T, true);
    t.recordUsage(1, "c1", "anthropic-claude", 1_500_000, 0, 0, "claude-opus-4-8");
    t.updateWeeklyBudgetEstimate(1, "anthropic-claude", 0.5);
    const wk = t.getCardWeeklyQuotaFractions(1, "c1");
    expect(wk["anthropic-claude"]).toBeDefined();
    expect(wk["anthropic-claude"].fraction).toBeCloseTo(0, 5);
    // 键是基础桶名(无 ::weekly 后缀),与 5h 对齐
    expect(Object.keys(wk).some((k) => k.includes("weekly"))).toBe(false);
    // getCardQuotaFractions(5h)仍只回 5h,不混入周键
    const fh = t.getCardQuotaFractions(1, "c1");
    expect(Object.keys(fh)).toContain("anthropic-claude");
    expect(Object.keys(fh).some((k) => k.includes("weekly"))).toBe(false);
  });

  it("trackWeekly 关闭 → 周血条为空", () => {
    const t = new FairShareTracker({
      getAccountPlanType: () => "pro", getBoundCardIds: () => [], getCardWeight: () => 1,
      accountShareCapacity: 8, now: () => T,
    });
    t.recordUsage(1, "c1", "anthropic-claude", 0, 100, 0, "claude-opus-4-8");
    expect(t.getCardWeeklyQuotaFractions(1, "c1")).toEqual({});
    expect(t.isWeeklyTracked()).toBe(false);
  });
});

describe("trackWeekly 默认关闭:行为与历史一致(antigravity)", () => {
  it("不创建周窗口,周喂数据方法 no-op", () => {
    const T = 1_700_000_000_000;
    const t = new FairShareTracker({
      getAccountPlanType: () => "pro", getBoundCardIds: () => [], getCardWeight: () => 1,
      accountShareCapacity: 8, now: () => T, // 无 trackWeekly
    });
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "claude-opus-4-8");
    expect(t.getBucketStateForTesting(1, "anthropic-claude")?.perCard.c1).toBeCloseTo(150, 5);
    expect(t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))).toBeNull();
    t.updateWeeklyBudgetEstimate(1, "anthropic-claude", 0.5); // no-op (trackWeekly off)
    expect(t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))).toBeNull();
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
