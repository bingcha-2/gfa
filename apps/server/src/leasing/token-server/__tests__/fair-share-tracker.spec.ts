import { QUOTA_WEIGHTS as SHARED_WEIGHTS } from "@gfa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeModelTier } from "../../lease-core/product-bucket";
import { FairShareTracker, weeklyBucketKey } from "../fair-share-tracker";

const T = 1_700_000_000_000;
const WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────────────
// weightedCost / 计价(权重派生自 pricing.json,重构后不变 —— 直接沿用旧固件)
// ────────────────────────────────────────────────────────────────────────────
describe("FairShareTracker.weightedCost (netInput)", () => {
  it("gemini: 缓存不被 input+cache 双算", () => {
    expect(FairShareTracker.weightedCost("antigravity-gemini", 180, 20, 80)).toBeCloseTo(240, 5);
  });
  it("gpt/codex: 输出 8×、缓存 0.10", () => {
    expect(FairShareTracker.weightedCost("codex-gpt", 17056, 28, 16000)).toBeCloseTo(2880, 5);
  });
  it("claude: 输出 5×、cache_read 0.10", () => {
    expect(FairShareTracker.weightedCost("anthropic-claude", 230, 10, 80)).toBeCloseTo(208, 5);
  });
  it("cached>input 防御:netInput 夹到 0", () => {
    expect(FairShareTracker.weightedCost("antigravity-gemini", 50, 0, 80)).toBe(20);
  });
});

describe("claudeModelTier:线上真实上报串归档", () => {
  it.each([
    ["claude-opus-4-8", "opus"],
    ["claude-opus-4-6-thinking", "opus"],
    ["claude-fable-5", "fable"],
    ["claude-haiku-4-5-20251001", "haiku"],
    ["claude-sonnet-4-6", "sonnet"],
    ["tab_flash_lite_preview", "autocomplete"],
  ] as const)("%s → %s", (modelKey, tier) => {
    expect(claudeModelTier(modelKey)).toBe(tier);
  });
});

describe("weightedCost:按 Claude 档位单价", () => {
  it.each([
    ["claude-opus-4-8", 150],
    ["claude-sonnet-4-6", 90],
    ["claude-haiku-4-5-20251001", 30],
    ["claude-fable-5", 300],
    ["tab_flash_lite_preview", 2.8],
  ] as const)("%s → %d", (modelKey, expected) => {
    expect(FairShareTracker.weightedCost(modelKey, 100, 10, 0)).toBeCloseTo(expected, 5);
  });
});

describe("QUOTA_WEIGHTS 派生自定价源", () => {
  it("claude 5/0.10、gemini 6/0.25、gpt 8/0.10", () => {
    expect(SHARED_WEIGHTS.claude.output).toBe(5);
    expect(SHARED_WEIGHTS.gemini.output).toBe(6);
    expect(SHARED_WEIGHTS.gpt.output).toBe(8);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test harness:可变绑定表 + 注入时钟(支持窗口内加/解绑)
// ────────────────────────────────────────────────────────────────────────────
type BoundMap = Record<number, Array<{ cardId: string; weight: number }>>;

function makeTracker(cfg: {
  now: () => number;
  bound: BoundMap;
  seats?: Record<number, number>;
  exclusiveAccounts?: Set<number>;
  trackWeekly?: boolean;
  prisma?: any;
}) {
  return new FairShareTracker({
    getCardWeight: (cardId: string) => {
      for (const list of Object.values(cfg.bound)) {
        const f = list.find((b) => b.cardId === cardId);
        if (f) return f.weight;
      }
      return 1;
    },
    getBoundCardWeights: (accountId: number) => cfg.bound[accountId] || [],
    getSeatCapacity: (accountId: number) => cfg.seats?.[accountId] ?? 8,
    isExclusiveAccount: (accountId: number) => cfg.exclusiveAccounts?.has(accountId) ?? false,
    trackWeekly: cfg.trackWeekly,
    prisma: cfg.prisma,
    provider: "codex",
    now: cfg.now,
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

// in-memory prisma fake for FairShareWindow persistence
function makeFsPrisma() {
  const store = new Map<string, any>();
  const fairShareWindow = {
    deleteMany: vi.fn(async ({ where }: any) => {
      let count = 0;
      for (const [k, v] of [...store]) if (v.provider === where.provider) { store.delete(k); count++; }
      return { count };
    }),
    createMany: vi.fn(async ({ data }: any) => {
      for (const row of data) store.set(`${row.provider}|${row.accountId}|${row.bucket}|${row.cardId}`, { ...row });
      return { count: data.length };
    }),
    findMany: vi.fn(async ({ where }: any) =>
      [...store.values()].filter((v) => v.provider === where.provider).map((v) => ({ ...v }))),
  };
  return { prisma: { fairShareWindow, $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)) }, store, fairShareWindow };
}

const BK = "codex-gpt";
/** 直接喂一笔 raw input 加权用量(gpt input 权重=1 → cost==input) */
function use(t: FairShareTracker, acc: number, card: string, cost: number, bucket = BK) {
  t.recordUsage(acc, card, bucket, cost, 0, 0);
}
function totalAttributed(t: FairShareTracker, acc: number, bucket = BK): number {
  return t.getBucketStateForTesting(acc, bucket)?.totalAttributed ?? 0;
}

// ────────────────────────────────────────────────────────────────────────────
// 独享号:D=Σw(忽略 N 保底),独享主人吃满账号 100% → e=1.0
// ────────────────────────────────────────────────────────────────────────────
describe("独享号 e=1.0", () => {
  it("独享单主 weight=4、N=10 → D=Σw=4(不被 N=10 稀释成 0.4)", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "EX", weight: 4 }] },
      seats: { 1: 10 },
      exclusiveAccounts: new Set([1]),
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 锁定 participants={EX}
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(4); // D=Σw,不是 max(10,4)=10
    // e=w/D=4/4=1.0 → 独享主人能吃到账号 100%:烧到 99% 仍放行。
    use(t, 1, "EX", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 0.01);
    expect(t.checkFairShare(1, "EX", BK).allowed).toBe(true);
  });

  it("非独享对照:同样 weight=4、N=10 → D=max(10,4)=10(e=0.4)", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "C", weight: 4 }] },
      seats: { 1: 10 },
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(10);
  });
});

// 双层血条几何:getCardQuotaFractions 每桶带 share=e_i(我的份额占整号比例)。
describe("share 字段(e_i,供客户端双层血条)", () => {
  it("双主平权(N=2)→ 每人 share=0.5", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] },
      seats: { 1: 2 },
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=2,e=0.5
    expect(t.getCardQuotaFractions(1, "O1")[BK].share).toBeCloseTo(0.5, 6);
  });

  it("独享单主 → share=1.0(独占整号)", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "EX", weight: 4 }] },
      seats: { 1: 10 },
      exclusiveAccounts: new Set([1]),
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=Σw=4,e=1.0
    expect(t.getCardQuotaFractions(1, "EX")[BK].share).toBeCloseTo(1.0, 6);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A. 基础分账(分段累加 T_i)
// ────────────────────────────────────────────────────────────────────────────
describe("A. 基础分账(分段累加)", () => {
  it("A2 双主平权全卖满(N=2):O1 用满 50% 被拦,号剩 50% 锁给 O2", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 锁定 participants={O1,O2},D=max(2,2)=2,e=0.5
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(2);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.5); // 账号烧 50%,全归 O1
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.5, 6);
    const c1 = t.checkFairShare(1, "O1", BK);
    expect(c1.allowed).toBe(false); // O1 用满自己 50%
    const c2 = t.checkFairShare(1, "O2", BK);
    expect(c2.allowed).toBe(true); // O2 没用,份额完好
    expect(c2.remainingFraction).toBeCloseTo(1, 6);
  });

  it("A3 等级加权(O1 w=2 / O2 w=1, N=3):线在 2/3 : 1/3", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 2 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 3 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=max(3,3)=3
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(3);
    use(t, 1, "O1", 100);
    use(t, 1, "O2", 300);
    t.applyAccountQuotaSnapshot(1, BK, 0.4); // 烧 0.6 按 100:300 切 → O1 +0.15 / O2 +0.45
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.15, 6);
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O2).toBeCloseTo(0.45, 6);
    // O1 线 = 2/3 ≈ 0.667 未到;O2 线 = 1/3 ≈ 0.333 已超 → O2 拦,O1 不拦
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true);
    expect(t.checkFairShare(1, "O2", BK).allowed).toBe(false);
  });

  it("A4 真·不变量 ΣT_i ≤ 1 − 低水位;每段增量 == Δ账号", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 30);
    use(t, 1, "O2", 70);
    t.applyAccountQuotaSnapshot(1, BK, 0.8); // Δ=0.2 → ΣT 增 0.2
    expect(totalAttributed(t, 1)).toBeCloseTo(0.2, 6);
    const lw = t.getBucketStateForTesting(1, BK)!.lastFraction;
    expect(totalAttributed(t, 1)).toBeLessThanOrEqual(1 - lw + 1e-9);
  });

  it("★A5 分段累加不被解封(回归 §4.3):O1 先用、O2 后猛用 → T_O1 不被稀释", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    // 第 1 段:只 O1 用,账号 100%→70%
    use(t, 1, "O1", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 0.7);
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.3, 6);
    // 第 2 段:O2 猛用,账号 70%→40%
    use(t, 1, "O2", 999999);
    t.applyAccountQuotaSnapshot(1, BK, 0.4);
    // T_O1 仍是 0.3(没被 O2 稀释),T_O2=0.3
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.3, 6);
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O2).toBeCloseTo(0.3, 6);
    expect(totalAttributed(t, 1)).toBeCloseTo(0.6, 6); // ≤ 1-0.4
  });

  it("A6 保底+预留(Σw<N):N=8 绑 2 → D=8,e=12.5%,预留 75%", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    const st = t.getBucketStateForTesting(1, BK)!;
    expect(st.D).toBe(8);
    expect(st.reserveAvail).toBeCloseTo(0.75, 6);
    expect(t.checkFairShare(1, "O1", BK).remainingFraction).toBeCloseTo(1, 6);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §15.1 低水位:fraction 回升/乱序不重复计数
// ────────────────────────────────────────────────────────────────────────────
describe("§15.1 低水位(fraction 非单调)", () => {
  it("★#32 回升/乱序 fraction 不重复计数,ΣT 不越界", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.6); // Δ=0.4 → T_O1=0.4
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.4, 6);
    // 回升噪声(resetAt 未变)→ Δ=0,低水位不被抬
    t.applyAccountQuotaSnapshot(1, BK, 0.8);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.6, 6);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.4); // Δ=max(0,0.6-0.4)=0.2 → T_O1=0.6(不是 0.8)
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.6, 6);
    expect(totalAttributed(t, 1)).toBeLessThanOrEqual(1 - 0.4 + 1e-9);
  });

  it("★#34 reset 只认 resetAt 前移,不认 fraction 跳变", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.1); // T_O1=0.9
    // fraction 暴涨到 0.95 但 resetAt 未喂入 → 不当作 reset
    t.applyAccountQuotaSnapshot(1, BK, 0.95);
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.9, 6); // 未清零
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.1, 6); // 低水位不被抬
  });
});

// ────────────────────────────────────────────────────────────────────────────
// B. 窗口对齐 / 账号刷新
// ────────────────────────────────────────────────────────────────────────────
describe("B. 窗口对齐 / 账号刷新", () => {
  it("★#34b resetAt 前移即解锁:T 清零、低水位复位、立刻可取号", () => {
    const now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0, T + WINDOW_MS); // 对齐:windowStart=T,e=0.5
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.5); // T_O1=0.5 ≥ e=0.5 → 拦
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(false);
    // 上游窗口 reset:resetAt 前移一个窗口
    t.applyAccountQuotaSnapshot(1, BK, 1.0, T + 2 * WINDOW_MS);
    expect(t.getBucketStateForTesting(1, BK)?.totalAttributed).toBe(0);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(1, 6);
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true);
  });

  it("★#12 自计时过期(ensureWindow)也清零 T_i", () => {
    let now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.1); // T_O1=0.9
    now = T + WINDOW_MS + 1; // 跨过 5h 边界
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true); // ensureWindow 触发清零
    expect(t.getBucketStateForTesting(1, BK)?.totalAttributed).toBe(0);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(1, 6);
  });

  it("#16 fraction=-1 不归并,u_i 继续累积,有效 fraction 回来一次性归并", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, -1); // 未知 → 不归并
    expect(totalAttributed(t, 1)).toBe(0);
    expect(t.getBucketStateForTesting(1, BK)?.perCard.O1).toBeCloseTo(100, 6); // u_i 保留
    t.applyAccountQuotaSnapshot(1, BK, 0.7); // Δ=0.3 一次性归并
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.3, 6);
  });

  it("★#17 D 锁定 / 加人下个窗口才生效(欠卖有预留 → 新人当窗口吃预留)", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 锁 participants={O1,O2},D=8,reserve=0.75
    // 窗口内绑 O3
    bound[1].push({ cardId: "O3", weight: 1 });
    const c3 = t.checkFairShare(1, "O3", BK);
    expect(c3.allowed).toBe(true); // 从预留领 1/8
    expect(c3.remainingFraction).toBeCloseTo(1, 6);
    // 老人 e_i 不变:O1 仍 1/8
    expect(t.checkFairShare(1, "O1", BK).remainingFraction).toBeCloseTo(1, 6);
    // D 未变
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(8);
  });

  it("★#35 满号窗口内加人不超卖:无预留 → 新人 e=0、拦;Σe≤1", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=max(2,2)=2,Σe=1,reserve=0
    expect(t.getBucketStateForTesting(1, BK)?.reserveAvail).toBeCloseTo(0, 6);
    bound[1].push({ cardId: "O3", weight: 1 }); // 窗口内加第 3 人
    const c3 = t.checkFairShare(1, "O3", BK);
    expect(c3.allowed).toBe(false); // 满号无预留 → 不发卡
    // 老人不被压线
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true);
  });

  it("★#18 D=max(N,Σw) 三档", () => {
    const mk = (cards: number, N: number) => {
      const list = Array.from({ length: cards }, (_, i) => ({ cardId: `c${i}`, weight: 1 }));
      const t = track(makeTracker({ now: () => T, bound: { 1: list }, seats: { 1: N } }));
      t.applyAccountQuotaSnapshot(1, BK, 1.0);
      return t.getBucketStateForTesting(1, BK)!;
    };
    expect(mk(2, 8).D).toBe(8); // Σw<N → D=N
    expect(mk(8, 8).D).toBe(8); // Σw=N → D=N
    expect(mk(12, 8).D).toBe(12); // Σw>N → D=Σw(超卖切薄)
  });
});

// ────────────────────────────────────────────────────────────────────────────
// C. 重启 / 持久化
// ────────────────────────────────────────────────────────────────────────────
describe("C. 重启 / 持久化", () => {
  it("★#17c 优雅重启全恢复:T_i / u_i / lastFraction / D 逐字段还原", async () => {
    const { prisma } = makeFsPrisma();
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t1 = track(makeTracker({ now: () => T, bound, seats: { 1: 8 }, prisma }));
    t1.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t1, 1, "O1", 100);
    t1.applyAccountQuotaSnapshot(1, BK, 0.6); // T_O1=0.4
    use(t1, 1, "O2", 50); // 段内 u_i 未归并
    await t1.flush();

    const t2 = track(makeTracker({ now: () => T, bound, seats: { 1: 8 }, prisma }));
    await t2.load();
    const st = t2.getBucketStateForTesting(1, BK)!;
    expect(st.attributed.O1).toBeCloseTo(0.4, 6); // T_i 恢复
    expect(st.perCard.O2).toBeCloseTo(50, 6); // u_i 恢复
    expect(st.lastFraction).toBeCloseTo(0.6, 6);
    expect(st.D).toBe(8); // 锁定 D 恢复
  });

  it("★#19 离线跨过 reset:load 时窗口已过期 → T_i=0、lastFraction=1", async () => {
    const { prisma } = makeFsPrisma();
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }] };
    const t1 = track(makeTracker({ now: () => T, bound, seats: { 1: 1 }, prisma }));
    t1.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t1, 1, "O1", 100);
    t1.applyAccountQuotaSnapshot(1, BK, 0.1);
    await t1.flush();

    const t2 = track(makeTracker({ now: () => T + WINDOW_MS + 1, bound, seats: { 1: 1 }, prisma }));
    await t2.load();
    const st = t2.getBucketStateForTesting(1, BK);
    expect(st?.totalAttributed ?? 0).toBe(0);
    expect(st?.totalUsed ?? 0).toBe(0);
  });

  it("★#30 历史 backfill:老行(无 attributedShare)→ T_i=(1−lastFraction)×weightedUsed/Σold", async () => {
    const { store } = makeFsPrisma();
    // 手造两条「老格式」行:有 weightedUsed + lastFraction,无 attributedShare/lockedDenominator
    const base = { provider: "codex", accountId: 1, bucket: BK, windowStart: BigInt(T), lastFraction: 0.6 };
    store.set("codex|1|codex-gpt|O1", { ...base, cardId: "O1", weightedUsed: 300 });
    store.set("codex|1|codex-gpt|O2", { ...base, cardId: "O2", weightedUsed: 100 });
    const prisma = { fairShareWindow: {
      findMany: async () => [...store.values()].map((v) => ({ ...v })),
      deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }),
    }, $transaction: async (ops: any[]) => Promise.all(ops) };

    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 8 }, prisma }));
    await t.load();
    const st = t.getBucketStateForTesting(1, BK)!;
    // Σold=400,(1−0.6)=0.4 → O1=0.4×300/400=0.3,O2=0.4×100/400=0.1
    expect(st.attributed.O1).toBeCloseTo(0.3, 6);
    expect(st.attributed.O2).toBeCloseTo(0.1, 6);
    expect(st.totalUsed).toBe(0); // 段内增量归零
    expect(st.lastFraction).toBeCloseTo(0.6, 6);
  });

  it("#dirty flush 是 no-op 直到状态再变化", async () => {
    const { prisma, fairShareWindow } = makeFsPrisma();
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 }, prisma }));
    use(t, 1, "O1", 100);
    await t.flush();
    expect(fairShareWindow.deleteMany).toHaveBeenCalledTimes(1);
    await t.flush();
    expect(fairShareWindow.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("★#36 满号窗口内加人 + 重启:新卡不被升为 participant、仍被拦(不超卖撞墙)", async () => {
    const { prisma } = makeFsPrisma();
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t1 = track(makeTracker({ now: () => T, bound, seats: { 1: 2 }, prisma }));
    t1.applyAccountQuotaSnapshot(1, BK, 1.0); // 满号:participants={O1,O2},D=2,reserve=0
    bound[1].push({ cardId: "O3", weight: 1 }); // 窗口内加第 3 人(满号 → e=0 被拦)
    expect(t1.checkFairShare(1, "O3", BK).allowed).toBe(false);
    await t1.flush();

    // 重启:O3 已在册,但持久化的 participants 集合仍是 {O1,O2} → 不把 O3 升为 participant。
    const t2 = track(makeTracker({ now: () => T, bound, seats: { 1: 2 }, prisma }));
    await t2.load();
    const st = t2.getBucketStateForTesting(1, BK)!;
    expect(st.participants.sort()).toEqual(["O1", "O2"]);
    expect(st.D).toBe(2);
    expect(t2.checkFairShare(1, "O3", BK).allowed).toBe(false); // 仍被拦,Σe≤1
    expect(t2.checkFairShare(1, "O1", BK).allowed).toBe(true); // 老人不受影响
  });

  it("★#37 血条展示是只读:不领预留(预留只在取号闸递减)", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 欠卖:D=8,reserve=0.75
    bound[1].push({ cardId: "O3", weight: 1 }); // 窗口内新卡
    // 仅展示 O3 血条(只读),不应消耗预留
    void t.getCardQuotaFractions(1, "O3");
    expect(t.getBucketStateForTesting(1, BK)?.reserveAvail).toBeCloseTo(0.75, 6);
    // 真正取号才领预留 1/8
    expect(t.checkFairShare(1, "O3", BK).allowed).toBe(true);
    expect(t.getBucketStateForTesting(1, BK)?.reserveAvail).toBeCloseTo(0.625, 6);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D. 超卖 / 烧不爆
// ────────────────────────────────────────────────────────────────────────────
describe("D. 超卖 / 永不烧爆", () => {
  it("★#21 任意序列 ΣT_i ≤ 1 − 低水位(含超卖)", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ cardId: `c${i}`, weight: 1 }));
    const t = track(makeTracker({ now: () => T, bound: { 1: list }, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=12
    let frac = 1.0;
    for (let seg = 0; seg < 5; seg++) {
      for (const c of list) use(t, 1, c.cardId, Math.random() * 100 + 1);
      frac = Math.max(0, frac - 0.15);
      t.applyAccountQuotaSnapshot(1, BK, frac);
      const lw = t.getBucketStateForTesting(1, BK)!.lastFraction;
      expect(totalAttributed(t, 1)).toBeLessThanOrEqual(1 - lw + 1e-9);
    }
  });

  it("★#22 e_i ≤ 1 自动成立(w>N 无需 clamp)", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "solo", weight: 20 }] }, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=max(8,20)=20 → e=20/20=1
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(20);
    expect(t.checkFairShare(1, "solo", BK).remainingFraction).toBeCloseTo(1, 6);
  });

  it("★#43 轻度超卖 N=8 卖 9:D=9,e=1/9,谁都不撞墙;到线才拦", () => {
    const list = Array.from({ length: 9 }, (_, i) => ({ cardId: `c${i}`, weight: 1 }));
    const t = track(makeTracker({ now: () => T, bound: { 1: list }, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(9);
    // 全员都能取号(没用)
    for (const c of list) expect(t.checkFairShare(1, c.cardId, BK).allowed).toBe(true);
    // c0 烧到 1/9 → 拦,其他不受影响
    use(t, 1, "c0", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 1 - 1 / 9 - 0.001);
    expect(t.checkFairShare(1, "c0", BK).allowed).toBe(false);
    expect(t.checkFairShare(1, "c1", BK).allowed).toBe(true);
  });

  it("★#46 超卖+idle:活跃者卡在 e_i,idle 份额物理留存", () => {
    const list = Array.from({ length: 8 }, (_, i) => ({ cardId: `c${i}`, weight: 1 }));
    const t = track(makeTracker({ now: () => T, bound: { 1: list }, seats: { 1: 4 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=max(4,8)=8 → e=1/8=12.5%
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(8);
    use(t, 1, "c0", 1000); // 仅 c0 用
    t.applyAccountQuotaSnapshot(1, BK, 0.8); // 烧 20% 全归 c0 → T_c0=0.2 > 0.125 → 拦
    expect(t.checkFairShare(1, "c0", BK).allowed).toBe(false);
    expect(t.checkFairShare(1, "c5", BK).allowed).toBe(true); // idle 不受影响
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F. 血条
// ────────────────────────────────────────────────────────────────────────────
describe("F. 血条 / 永不超卖显示", () => {
  it("#27 血条 == clamp((e−T)/e,0,1)", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // e=0.5
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.75); // T_O1=0.25 → 血条 (0.5-0.25)/0.5=0.5
    expect(t.getCardQuotaFractions(1, "O1")[BK].fraction).toBeCloseTo(0.5, 6);
  });

  it("★#39 e_i=0(w=0)→ 血条 0 且拦,不矛盾", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "Z", weight: 0 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    expect(t.checkFairShare(1, "Z", BK).allowed).toBe(false);
    expect(t.getCardQuotaFractions(1, "Z")[BK].fraction).toBe(0);
  });

  it("★#28 血条永远 ∈ [0,1](T>e 夹到 0)", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.2); // T_O1=0.8 > e=0.5
    const f = t.getCardQuotaFractions(1, "O1")[BK].fraction;
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
    expect(f).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 周窗口(trackWeekly) + 自动补全
// ────────────────────────────────────────────────────────────────────────────
describe("周窗口 + 自动补全", () => {
  it("自动补全不计入任何窗口", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "c1", weight: 1 }] }, seats: { 1: 8 }, trackWeekly: true }));
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "tab_flash_lite_preview");
    expect(t.getBucketStateForTesting(1, "anthropic-claude")).toBeNull();
  });

  it("每笔成本同时进 5h 与周两个独立窗口", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "c1", weight: 1 }] }, seats: { 1: 8 }, trackWeekly: true }));
    t.recordUsage(1, "c1", "anthropic-claude", 100, 10, 0, "claude-opus-4-8"); // 150
    expect(t.getBucketStateForTesting(1, "anthropic-claude")?.perCard.c1).toBeCloseTo(150, 5);
    expect(t.getBucketStateForTesting(1, weeklyBucketKey("anthropic-claude"))?.perCard.c1).toBeCloseTo(150, 5);
  });

  it("★#63 周超 5h 不超 → 被周拦", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "c1", weight: 1 }] }, seats: { 1: 1 }, trackWeekly: true }));
    t.applyAccountQuotaSnapshot(1, "anthropic-claude", 1.0);
    t.applyWeeklyAccountQuotaSnapshot(1, "anthropic-claude", 1.0);
    t.recordUsage(1, "c1", "anthropic-claude", 100, 0, 0, "claude-opus-4-8");
    t.applyAccountQuotaSnapshot(1, "anthropic-claude", 0.9); // 5h 只烧 10%
    t.applyWeeklyAccountQuotaSnapshot(1, "anthropic-claude", 0.0); // 周见底
    const r = t.checkFairShare(1, "c1", "anthropic-claude");
    expect(r.allowed).toBe(false);
    expect(r.window).toBe("7d");
    expect(r.resetAt).toBe(T + WEEKLY_MS);
  });

  it("trackWeekly 关闭 → 周血条为空", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "c1", weight: 1 }] }, seats: { 1: 8 } }));
    use(t, 1, "c1", 100);
    expect(t.getCardWeeklyQuotaFractions(1, "c1")).toEqual({});
    expect(t.isWeeklyTracked()).toBe(false);
  });
});

describe("getCardWindowUsed", () => {
  it("跨 bucket 求和 5h 段内用量", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "c1", weight: 1 }] }, seats: { 1: 8 } }));
    t.recordUsage(1, "c1", "codex-gpt", 100, 0, 0);
    t.recordUsage(1, "c1", "anthropic-claude", 0, 10, 0); // 10*5=50
    expect(t.getCardWindowUsed(1, "c1")).toBeCloseTo(150, 5);
    expect(t.getCardWindowUsed(1, "absent")).toBe(0);
  });
});
