// 修法二:凡是"猜的" 1.0 基线(自计时过期 reset / load 过期行 / 无真实 fraction 的前移 reset)
// 一律 primed=false —— 首个真实快照【采纳】为基线(cold-adopt),而不是对着假 1.0 【归并】出
// delta=1−真值 的凭空消耗(S2 秒归0 / S5 集体掉的公共毒根)。
import { describe, it, expect, afterEach, vi } from "vitest";
import { FairShareTracker } from "../fair-share-tracker";

const T = 1_700_000_000_000;
const BK = "codex-gpt";
const WINDOW_MS = 5 * 60 * 60 * 1000;
const trackers: FairShareTracker[] = [];
afterEach(() => { while (trackers.length) trackers.pop()?.destroy(); });

type Bound = Record<number, Array<{ cardId: string; weight: number }>>;
function mk(bound: Bound, seats: Record<number, number>, now: () => number, prisma?: any): FairShareTracker {
  const t = new FairShareTracker({
    getCardWeight: (id: string) => { for (const l of Object.values(bound)) { const f = l.find((b) => b.cardId === id); if (f) return f.weight; } return 1; },
    getBoundCardWeights: (acc: number) => bound[acc] || [],
    getSeatCapacity: (acc: number) => seats[acc] ?? 8,
    isExclusive: () => false,
    provider: "codex",
    now,
    prisma,
  } as any);
  trackers.push(t);
  return t;
}
const use = (t: FairShareTracker, acc: number, card: string, cost: number) => t.recordUsage(acc, card, BK, cost, 0, 0);
const st = (t: FairShareTracker, acc: number) => t.getBucketStateForTesting(acc, BK)!;

describe("修法二:假基线 primed=false → 首个真值采纳不归并", () => {
  it("自计时过期 reset 后,首个真实值采纳为基线,活跃卡不被凭空扣 delta", () => {
    const clock = { t: T };
    const t = mk({ 19: [{ cardId: "X", weight: 1 }, { cardId: "Y", weight: 1 }] }, { 19: 2 }, () => clock.t);
    t.applyAccountQuotaSnapshot(19, BK, 1.0); // 真实建窗
    use(t, 19, "X", 100);
    t.applyAccountQuotaSnapshot(19, BK, 0.9); // 正常归并:X 吃 delta 0.1

    // 跨过 5h 窗口 → 下一次操作触发自计时过期 reset(猜 1.0)。
    clock.t += WINDOW_MS + 1;
    use(t, 19, "X", 50); // ensureWindow 自计时 reset,然后 X 记 perCard=50
    t.applyAccountQuotaSnapshot(19, BK, 0.46); // 真实值回来

    const xAttr = st(t, 19).attributed.X ?? 0;
    // 自计时 reset 的 1.0 是"猜的",不该当基线归并。X 只用了 50,不该被凭空扣 (1−0.46)=0.54。
    // 旧代码(primed=true)会让 X.attributed≈0.54;修法二(primed=false 采纳)应 ≈0。
    expect(xAttr).toBeLessThan(0.1);
    expect(st(t, 19).lastFraction).toBeCloseTo(0.46, 5);
  });

  it("load() 恢复过期行时基线不可信 → 首个真值采纳,重启不毒化", async () => {
    // 造一个"本地时钟已过期"的持久化行(windowStart 陈旧、lastFraction=1),模拟重启读回。
    const clock = { t: T };
    const store = new Map<string, any>();
    store.set(`codex|19|${BK}|X`, {
      provider: "codex", accountId: 19, bucket: BK, cardId: "X",
      windowStart: T - WINDOW_MS - 1000, // 已过期
      weightedUsed: 0, attributedShare: 0, lockedDenominator: 2,
      lastFraction: 1, isParticipant: true,
    });
    const prisma = {
      fairShareWindow: {
        findMany: vi.fn(async () => [...store.values()].map((v) => ({ ...v }))),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
    };
    const t = mk({ 19: [{ cardId: "X", weight: 1 }, { cardId: "Y", weight: 1 }] }, { 19: 2 }, () => clock.t, prisma);
    await t.load();

    use(t, 19, "X", 50); // 重启后 X 发请求
    t.applyAccountQuotaSnapshot(19, BK, 0.46); // 首个真实值
    const xAttr = st(t, 19).attributed.X ?? 0;
    // 重启恢复的过期行 lastFraction=1 是"猜的满血",不该当基线归并把 0.54 砸给 X。
    expect(xAttr).toBeLessThan(0.1);
  });
});
