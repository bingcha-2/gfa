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
// 独享超卖改造:exclusive 不再特殊化,D 统一 = max(N, Σw)
// ────────────────────────────────────────────────────────────────────────────
describe("独享走拼车路径(超卖改造)", () => {
  it("原独享号 weight=4、N=10 → D=max(10,4)=10(和非独享一样,不再特判 D=Σw)", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "EX", weight: 4 }] },
      seats: { 1: 10 },
      exclusiveAccounts: new Set([1]),
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(10);
  });

  it("原独享号不再吃满 100%:e=4/10=0.4,烧到 99% 时被拦", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "EX", weight: 4 }] },
      seats: { 1: 10 },
      exclusiveAccounts: new Set([1]),
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "EX", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 0.01);
    // e=0.4 → 本人份额 40%,烧到号剩 1% 时已远超自己那 40% → 被拦
    expect(t.checkFairShare(1, "EX", BK).allowed).toBe(false);
  });
});

// share 字段(e_i,供客户端血条)
describe("share 字段(e_i,供客户端血条)", () => {
  it("双主平权(N=2)→ 每人 share=0.5", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] },
      seats: { 1: 2 },
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    expect(t.getCardQuotaFractions(1, "O1")[BK].share).toBeCloseTo(0.5, 6);
  });

  it("原独享单主 weight=4、N=10 → share=0.4(不再是 1.0)", () => {
    const t = track(makeTracker({
      now: () => T,
      bound: { 1: [{ cardId: "EX", weight: 4 }] },
      seats: { 1: 10 },
      exclusiveAccounts: new Set([1]),
    }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    expect(t.getCardQuotaFractions(1, "EX")[BK].share).toBeCloseTo(0.4, 6);
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
// 冷启动:首个快照(无 1.0 基线)直接采纳为低水位,不把窗口前消耗砸给当前用户
// (回归:迁移清空 FairShareWindow 后,周窗口账号已烧到 6% → 首个活跃卡被砸 94% → 血条归零)
// ────────────────────────────────────────────────────────────────────────────
describe("冷启动首快照采纳基线(§9/§344)", () => {
  it("CS1 冷建 tracker 首个快照 fraction=0.06 → 采纳为低水位,不归因任何卡", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 8 } }));
    // 没有先喂 1.0:模拟迁移清表后,服务端首次见到的是账号已烧到 6% 的现状
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.06);
    // 窗口前(冷启动前)被别人烧掉的 94% 不该砸给 O1
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1 ?? 0).toBeCloseTo(0, 6);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.06, 6);
    // O1 没被归因(T=0)→ 不拦;但血条按账号低水位封顶:
    // e=1/8=0.125 > 账号 0.06 → 我那份剩 = min(0.125,0.06)/0.125 = 0.48(不是 1,见账号封顶测试)
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true);
    expect(t.getCardQuotaFractions(1, "O1")[BK].fraction).toBeCloseTo(0.48, 6);
  });

  it("CS2 采纳基线后,后续真实下降照常按段归因", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }], }, seats: { 1: 1 } }));
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.5); // 冷启动:采纳 0.5 为基线,T=0
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1 ?? 0).toBeCloseTo(0, 6);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.3); // Δ=0.2 → 照常归因 0.2
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.2, 6);
  });

  it("CS4 冷启动对齐上游窗口:首个周快照带 resetAt → windowStart 采纳真实起点(可后移),倒计时对齐上游而非 now+7d", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 8 }, trackWeekly: true }));
    const upstreamWeeklyReset = T + 46 * 60 * 60 * 1000; // 上游周窗口还剩 46h(后台 1天22时)
    t.applyWeeklyAccountQuotaSnapshot(1, BK, 0.06, upstreamWeeklyReset);
    const wk = t.getBucketStateForTesting(1, weeklyBucketKey(BK));
    // windowStart 应采纳 = resetAt − 7d(在过去 5 天),而非冷启动猜测的 now
    expect(wk?.windowStart).toBeCloseTo(upstreamWeeklyReset - WEEKLY_MS, -3);
    // 血条回传的 resetAt 对齐上游(46h 后),不是 now+7d
    const q = t.getCardWeeklyQuotaFractions(1, "O1")[BK];
    expect(q.resetAt).toBeCloseTo(upstreamWeeklyReset, -3);
  });

  it("CS3 首快照 fraction 未知(-1)不采纳,等首个有效快照才定基线", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, -1); // 未知:不采纳
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.4); // 首个有效快照:采纳 0.4,不归因
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1 ?? 0).toBeCloseTo(0, 6);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.4, 6);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 账号余量封顶:血条「我的总剩余」绝不超过账号实际余量(回归:绿条戳出灰条)
// 未认领消耗(冷启动前消耗 / 轮换卡 / 未认领段)把账号烧低 → (e_i−T_i) > 账号余量 →
// 旧 bloodBar 报「我那份剩 100% / 我的总剩余 10%」而账号只剩 6%,物理不可能。
// ────────────────────────────────────────────────────────────────────────────
describe("账号余量封顶(我的总剩余 ≤ 账号余量)", () => {
  it("AC1 账号烧到 6%、份额 10%、T=0 → 我那份剩封顶 60%,我的总剩余=6% 不戳穿账号", () => {
    // N=10 → e=w/D=1/10=10%(对齐截图「占整号 10%」);账号被非分账用量烧到 6%
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 10 } }));
    use(t, 1, "O1", 1); // 建 tracker
    t.applyAccountQuotaSnapshot(1, BK, 0.06); // 冷启动采纳基线 → lastFraction=0.06, T_O1=0
    const q = t.getCardQuotaFractions(1, "O1")[BK];
    expect(q.share).toBeCloseTo(0.1, 6); // 占整号 10%
    // 核心不变量:我的总剩余(share × fraction)≤ 账号余量(lastFraction)
    expect(q.share * q.fraction).toBeLessThanOrEqual(0.06 + 1e-9);
    // 具体:我那份剩 = min(0.1, 0.06)/0.1 = 60%
    expect(q.fraction).toBeCloseTo(0.6, 6);
  });

  it("AC2 账号健康(余量 > 份额)→ 不封顶,血条照旧", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 10 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 账号满
    const q = t.getCardQuotaFractions(1, "O1")[BK];
    expect(q.fraction).toBeCloseTo(1, 6); // min(0.1,1.0)/0.1 = 1.0,不受影响
  });

  it("AC3 账号见底(0%)→ 我那份剩归 0", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 10 } }));
    use(t, 1, "O1", 1);
    t.applyAccountQuotaSnapshot(1, BK, 0); // 账号干涸
    expect(t.getCardQuotaFractions(1, "O1")[BK].fraction).toBeCloseTo(0, 6);
  });

  it("AC4 超卖多人(10份卖10人/账号6%):等比例缩放,各人我的总剩余=0.6%,加总=账号6%", () => {
    // 10 份卖给 10 人(各 w=1),N=8 → D=max(8,10)=10,e=1/10=10%;账号被未认领消耗烧到 6%
    const bound = Array.from({ length: 10 }, (_, i) => ({ cardId: `O${i}`, weight: 1 }));
    const t = track(makeTracker({ now: () => T, bound: { 1: bound }, seats: { 1: 8 } }));
    bound.forEach((b) => use(t, 1, b.cardId, 1)); // 建 tracker、各有用量
    t.applyAccountQuotaSnapshot(1, BK, 0.06); // 冷启动采纳基线 → T_i 全 0
    let sumMine = 0;
    for (const b of bound) {
      const q = t.getCardQuotaFractions(1, b.cardId)[BK];
      const mine = q.share * q.fraction; // 我的总剩余(对整号)
      sumMine += mine;
      expect(mine).toBeCloseTo(0.006, 6); // 各人 0.6%,不是 6%
    }
    expect(sumMine).toBeCloseTo(0.06, 6); // 加总恰好 = 账号 6%(不再超分)
  });

  it("AC5 单人时等比例退化成 min 封顶(e=50%、账号30% → 我的总剩余=30%)", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    use(t, 1, "O1", 1);
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 先满,锁 e=0.5
    // O2 烧光自己(T_O2=0.5),O1 没用 → 仅 O1 一人还有剩;账号被烧到 0.3
    use(t, 1, "O2", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 0.3);
    const q = t.getCardQuotaFractions(1, "O1")[BK];
    // 仅 O1 有剩:ΣRem = 0.5;scale = 0.3/0.5 = 0.6 → 我的总剩余 = 0.5×0.6 = 0.3 = 账号
    expect(q.share * q.fraction).toBeCloseTo(0.3, 6);
  });

  it("AC6 干净运行=隔离:同号他人在份额内用,我的血条纹丝不动(系数恒=1)", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 采纳基线、锁 e=0.5
    use(t, 1, "O2", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 0.7); // O2 在份额内烧 0.3,全归 O2;账号 A=0.7
    // 归账干净 → A = ΣRem = 0.7 → 系数=1 → O1 不受 O2 影响(隔离)
    expect(t.getCardQuotaFractions(1, "O1")[BK].fraction).toBeCloseTo(1, 6);
    expect(t.getCardQuotaFractions(1, "O2")[BK].fraction).toBeCloseTo(0.4, 6);
    const o1 = t.getCardQuotaFractions(1, "O1")[BK];
    const o2 = t.getCardQuotaFractions(1, "O2")[BK];
    expect(o1.share * o1.fraction + o2.share * o2.fraction).toBeCloseTo(0.7, 6); // 加总=账号
  });

  it("AC7 他人冲破份额烧穿账号:超额者归0、守规者按剩余等比例吸收,加总=账号", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O2", 1000);
    t.applyAccountQuotaSnapshot(1, BK, 0.3); // O2 一笔冲过头:T_O2=0.7 > e=0.5;账号 A=0.3
    // ΣRem = 0.5(O1) + 0(O2 耗尽,不稀释) = 0.5;系数 = 0.3/0.5 = 0.6
    expect(t.getCardQuotaFractions(1, "O1")[BK].fraction).toBeCloseTo(0.6, 6); // O1 100%→60%
    expect(t.getCardQuotaFractions(1, "O2")[BK].fraction).toBeCloseTo(0, 6); // O2 归 0
    const o1 = t.getCardQuotaFractions(1, "O1")[BK];
    expect(o1.share * o1.fraction).toBeCloseTo(0.3, 6); // O1 我的总剩余 = 0.3 = 账号(独占剩余)
  });

  it("AC8 加权份额按剩余等比例缩放(O1 w=2 / O2 w=1, 账号30%)", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 2 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 3 } }));
    t.applyAccountQuotaSnapshot(1, BK, 0.3); // 冷启动采纳:T=0,e_O1=2/3,e_O2=1/3,A=0.3,ΣRem=1
    const o1 = t.getCardQuotaFractions(1, "O1")[BK];
    const o2 = t.getCardQuotaFractions(1, "O2")[BK];
    expect(o1.share * o1.fraction).toBeCloseTo(0.2, 6); // 2/3 × 0.3
    expect(o2.share * o2.fraction).toBeCloseTo(0.1, 6); // 1/3 × 0.3
    expect(o1.share * o1.fraction + o2.share * o2.fraction).toBeCloseTo(0.3, 6); // 加总=账号
  });

  it("AC9 欠卖(有预留)账号满:不缩放,各人满份额,加总=Σ份额 < 账号", () => {
    const t = track(makeTracker({ now: () => T, bound: { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] }, seats: { 1: 8 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=8,e=1/8 各,reserve=0.75,ΣRem=0.25 < A=1 → 系数=1
    const o1 = t.getCardQuotaFractions(1, "O1")[BK];
    expect(o1.fraction).toBeCloseTo(1, 6); // 满份额
    expect(o1.share).toBeCloseTo(0.125, 6);
    expect(o1.share * o1.fraction).toBeCloseTo(0.125, 6); // 我的总剩余=份额,无缩放
  });

  it("AC10 不变量:任意时刻 各人我的总剩余 ≤ 账号 且 Σ ≤ 账号(加权混合用量序列)", () => {
    const bound = Array.from({ length: 4 }, (_, i) => ({ cardId: `O${i}`, weight: i + 1 })); // w=1,2,3,4
    const t = track(makeTracker({ now: () => T, bound: { 1: bound }, seats: { 1: 4 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // D=max(4,10)=10,Σe=1
    const checkInvariant = (A: number) => {
      let sum = 0;
      for (const b of bound) {
        const q = t.getCardQuotaFractions(1, b.cardId)[BK];
        const mine = q.share * q.fraction;
        expect(mine).toBeLessThanOrEqual(A + 1e-9); // 各人 ≤ 账号
        expect(q.fraction).toBeGreaterThanOrEqual(0);
        expect(q.fraction).toBeLessThanOrEqual(1 + 1e-9);
        sum += mine;
      }
      expect(sum).toBeLessThanOrEqual(A + 1e-9); // 加总 ≤ 账号
    };
    use(t, 1, "O0", 500);
    use(t, 1, "O3", 1500);
    t.applyAccountQuotaSnapshot(1, BK, 0.5);
    checkInvariant(0.5);
    use(t, 1, "O1", 99999); // O1 猛烧、冲破份额
    t.applyAccountQuotaSnapshot(1, BK, 0.1);
    checkInvariant(0.1);
    t.applyAccountQuotaSnapshot(1, BK, 0.02); // 账号继续烧低(未认领)
    checkInvariant(0.02);
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
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.1, 6); // 低水位不被抬(单次)
  });

  // 上游可能「刷额度不动 resetAt」(重置额度 ≠ 重置时间),故回升判定不能靠 resetAt 前移。
  // 也不能靠纯次数(高频号几秒就凑够),改用「持续 ≥5min + ≥2 次读数 + 涨幅超容差」才抬。
  const REBOUND_MS = 5 * 60 * 1000;
  it("★#35 回升持续够久才抬低水位(刷额度不动 resetAt 也能回升)", () => {
    let now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.6); // 低水位 0.6,T_O1=0.4
    // 回升候选,但持续时间不够 → 不抬
    t.applyAccountQuotaSnapshot(1, BK, 0.9);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.6, 6);
    now += 60 * 1000; // +1min(未达 5min)
    t.applyAccountQuotaSnapshot(1, BK, 0.9);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.6, 6);
    // 持续超过 5min 后再确认 → 抬到 0.9(无 resetAt 喂入);T_O1 不变(回升不归因)
    now += REBOUND_MS;
    t.applyAccountQuotaSnapshot(1, BK, 0.9);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.9, 6);
    expect(t.getBucketStateForTesting(1, BK)?.attributed.O1).toBeCloseTo(0.4, 6);
  });

  it("★#35b 高频凑次数但持续时间不够 → 不抬(抗瞬时虚高)", () => {
    let now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.6); // 低水位 0.6
    // 高频连刷 6 次高值,但总共只跨 3min(<5min)→ 次数够、时间不够 → 不抬
    for (let i = 0; i < 6; i++) {
      now += 30 * 1000;
      t.applyAccountQuotaSnapshot(1, BK, 0.9);
    }
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.6, 6);
  });

  it("★#35c 回升不要求读数相同:抖动的高值也确认(取最低高值)", () => {
    let now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.6); // 低水位 0.6
    t.applyAccountQuotaSnapshot(1, BK, 0.95); // 高值(不同数)
    now += REBOUND_MS;
    t.applyAccountQuotaSnapshot(1, BK, 0.92); // 仍是高值但数不同 → 确认,抬到最低高值 0.92
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.92, 6);
  });

  it("★#35d 回升中途被真跌打断 → 重新计时,不抬", () => {
    let now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.6); // 低水位 0.6
    t.applyAccountQuotaSnapshot(1, BK, 0.9); // 回升候选(since=now)
    now += REBOUND_MS; // 时间已够
    t.applyAccountQuotaSnapshot(1, BK, 0.5); // 但真跌打断 → 低水位降到 0.5,计时清零
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.5, 6);
    // 再回升:since 重置为现在,刚开始不抬
    t.applyAccountQuotaSnapshot(1, BK, 0.9);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(0.5, 6);
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

  it("ignores an old-window snapshot that arrives after an upstream reset", () => {
    const now = T;
    const t = track(makeTracker({ now: () => now, bound: { 1: [{ cardId: "O1", weight: 1 }] }, seats: { 1: 1 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0, T + WINDOW_MS);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.0, T + WINDOW_MS);
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(false);

    t.applyAccountQuotaSnapshot(1, BK, 1.0, T + 2 * WINDOW_MS);
    expect(t.getBucketStateForTesting(1, BK)?.lastFraction).toBeCloseTo(1, 6);
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true);

    t.applyAccountQuotaSnapshot(1, BK, 0.0, T + WINDOW_MS);
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
// E. 中途加超卖人即时生效(refreshParticipants)
// ────────────────────────────────────────────────────────────────────────────
describe("E. refreshParticipants:满号中途加人当窗口生效", () => {
  it("★#47 满号窗口内加人 + refreshParticipants:即时升 participant、当窗口享保底", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0); // 满号:participants={O1,O2},D=2,reserve=0
    bound[1].push({ cardId: "O3", weight: 1 }); // 窗口内加超卖第 3 人
    expect(t.checkFairShare(1, "O3", BK).allowed).toBe(false); // 提升前:无预留 → 拦
    t.refreshParticipants(1); // 中途提升:重算 D=max(2,3)=3,O3 成 participant
    const st = t.getBucketStateForTesting(1, BK)!;
    expect(st.D).toBe(3);
    expect(st.participants.sort()).toEqual(["O1", "O2", "O3"]);
    expect(t.checkFairShare(1, "O3", BK).allowed).toBe(true); // O3 当窗口即享 e=1/3
    expect(t.checkFairShare(1, "O1", BK).allowed).toBe(true); // 老人被稀释但仍可用
  });

  it("★#48 refreshParticipants 保留已烧 T_i / 低水位,不重置窗口", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 2 } }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    use(t, 1, "O1", 100);
    t.applyAccountQuotaSnapshot(1, BK, 0.7); // Δ=0.3 → T_O1=0.3
    bound[1].push({ cardId: "O3", weight: 1 });
    t.refreshParticipants(1);
    const st = t.getBucketStateForTesting(1, BK)!;
    expect(st.attributed.O1).toBeCloseTo(0.3, 6); // T_i 保留
    expect(st.lastFraction).toBeCloseTo(0.7, 6); // 低水位保留
    expect(st.windowStart).toBe(T); // 窗口未重置
  });

  it("★#49 同时刷新 5h 与周窗口", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 2 }, trackWeekly: true }));
    t.applyAccountQuotaSnapshot(1, BK, 1.0);
    t.applyWeeklyAccountQuotaSnapshot(1, BK, 1.0);
    bound[1].push({ cardId: "O3", weight: 1 });
    expect(t.checkFairShare(1, "O3", BK).allowed).toBe(false); // 周窗口满 → 拦
    t.refreshParticipants(1);
    expect(t.getBucketStateForTesting(1, BK)?.D).toBe(3);
    expect(t.getBucketStateForTesting(1, weeklyBucketKey(BK))?.D).toBe(3);
    expect(t.checkFairShare(1, "O3", BK).allowed).toBe(true);
  });

  it("★#50 无 tracker 的号 no-op(首用懒算已正确,不预建)", () => {
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }] };
    const t = track(makeTracker({ now: () => T, bound, seats: { 1: 8 } }));
    t.refreshParticipants(1);
    expect(t.getBucketStateForTesting(1, BK)).toBeNull();
  });

  it("★#51 提升后跨重启仍是 participant(持久化 isParticipant)", async () => {
    const { prisma } = makeFsPrisma();
    const bound: BoundMap = { 1: [{ cardId: "O1", weight: 1 }, { cardId: "O2", weight: 1 }] };
    const t1 = track(makeTracker({ now: () => T, bound, seats: { 1: 2 }, prisma }));
    t1.applyAccountQuotaSnapshot(1, BK, 1.0);
    bound[1].push({ cardId: "O3", weight: 1 });
    t1.refreshParticipants(1);
    await t1.flush();

    const t2 = track(makeTracker({ now: () => T, bound, seats: { 1: 2 }, prisma }));
    await t2.load();
    const st = t2.getBucketStateForTesting(1, BK)!;
    expect(st.participants.sort()).toEqual(["O1", "O2", "O3"]); // O3 升格随重启保留
    expect(t2.checkFairShare(1, "O3", BK).allowed).toBe(true);
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
