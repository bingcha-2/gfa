import { afterEach, describe, expect, it } from "vitest";

import { FairShareTracker, weeklyBucketKey } from "../fair-share-tracker";

/**
 * 复现:独享单卡号「重启即自愈」缺口(冷启动回补的姊妹漏)。
 *
 * 冷启动回补(applySnapshot §3a)只在 primed=false 那一刻生效。但 tracker 是持久化的:
 * FairShareWindow 落库后,重启 load() 无条件 primed:true → 跳过冷启动回补。
 * 于是修复上线【前】被冷启动写坏的行(lastFraction=重启那刻母号余量、T=0)在库里躺着,
 * 修复上线 + 重启也修不好它 —— load 读回坏行 primed:true,冷启动那段一次都不跑,
 * 血条虚高一整周(周窗口 7 天不 reset),app 端点刷新走归并路径也永远碰不到回补。
 *
 * 修复:load() 期做与冷启动【同源】的独享回补 —— 号上只有这一张卡、是独享、占满整号(e≈1)时,
 * 已烧的 (1−lastFraction) 归属无歧义 → 补进 T。且「只抬不压」(burned>cur):已正确落库的行
 * (cur≈burned)跳过、窗口内已烧更多的行(cur>burned)不被压回,避免二次归因把 T 打低致血条回弹。
 */

const T = 1_700_000_000_000;
const ACC = 1;
const BASE = "anthropic-claude";
const WBK = weeklyBucketKey(BASE);

const trackers: FairShareTracker[] = [];
afterEach(() => {
  while (trackers.length) trackers.pop()?.destroy();
});

/** 造一个只读 prisma fake,findMany 直接吐出手工构造的坏行(模拟修复前落库)。 */
function prismaWithRows(rows: Array<Record<string, unknown>>) {
  return {
    fairShareWindow: {
      findMany: async () => rows.map((r) => ({ ...r })),
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
}

/**
 * 一条「新 schema」持久化周窗口行(lockedDenominator>0 → hasNewSchema=true)。
 * 缺省即坏行:attributedShare=0(修复前冷启动没回补)、lastFraction=0.33(把母号余量当低水位)。
 */
function weeklyRow(over: Partial<{
  cardId: string;
  attributedShare: number;
  lastFraction: number;
  lockedDenominator: number;
  weightedUsed: number;
  isParticipant: boolean;
}> = {}) {
  return {
    provider: "anthropic",
    accountId: ACC,
    bucket: WBK,
    cardId: over.cardId ?? "C",
    windowStart: BigInt(T),
    weightedUsed: over.weightedUsed ?? 500,
    attributedShare: over.attributedShare ?? 0,
    lockedDenominator: over.lockedDenominator ?? 8, // 新 schema:D 已锁定
    lastFraction: over.lastFraction ?? 0.33,
    isParticipant: over.isParticipant ?? true,
  };
}

function makeTracker(cfg: {
  rows: Array<Record<string, unknown>>;
  bound: Array<{ cardId: string; weight: number }>;
  exclusive: Set<string>;
}) {
  const t = new FairShareTracker({
    getCardWeight: (id) => cfg.bound.find((b) => b.cardId === id)?.weight ?? 1,
    getBoundCardWeights: () => cfg.bound,
    getSeatCapacity: () => 8, // N=8
    isExclusive: (id) => cfg.exclusive.has(id),
    trackWeekly: true,
    provider: "anthropic",
    prisma: prismaWithRows(cfg.rows),
    now: () => T,
  });
  trackers.push(t);
  return t;
}

const weeklyPct = (t: FairShareTracker, card = "C"): number =>
  Math.round((t.getCardWeeklyQuotaFractions(ACC, card)[BASE]?.fraction ?? -1) * 100);
const tOf = (t: FairShareTracker, card = "C"): number =>
  t.getBucketStateForTesting(ACC, WBK)?.attributed[card] ?? 0;

describe("独享号 load 期自愈:重启读回坏行也能修血条虚高", () => {
  it("坏行(独享·占满整号·T=0·lastFraction=0.33)load 后回补 T=0.67 → 血条 33%,不再虚高 100%", async () => {
    const t = makeTracker({
      rows: [weeklyRow()], // C:w=8,独享占满整号,T=0,lastFraction=0.33
      bound: [{ cardId: "C", weight: 8 }],
      exclusive: new Set(["C"]),
    });
    await t.load();
    expect(tOf(t)).toBeCloseTo(0.67, 6);
    expect(weeklyPct(t)).toBe(33);
  });

  it("只抬不压:窗口内已烧更多的行(T=0.80 > burned=0.67)load 后 T 不被压回 → 血条守住 20%", async () => {
    const t = makeTracker({
      rows: [weeklyRow({ attributedShare: 0.8 })], // 已正确烧到 80%
      bound: [{ cardId: "C", weight: 8 }],
      exclusive: new Set(["C"]),
    });
    await t.load();
    expect(tOf(t)).toBeCloseTo(0.8, 6); // 不被回补的 0.67 覆盖
    expect(weeklyPct(t)).toBe(20);
  });

  it("非独享单卡:load 不回补(T 留 0),走 scale 护栏自愈,不改归因语义", async () => {
    const t = makeTracker({
      rows: [weeklyRow()], // 同样占满整号,但非独享
      bound: [{ cardId: "C", weight: 8 }],
      exclusive: new Set(), // 拼车语义
    });
    await t.load();
    expect(tOf(t)).toBe(0); // 不回补
  });

  it("多卡(participants>1):归属有歧义,load 不回补任一卡(即便都独享)", async () => {
    const t = makeTracker({
      rows: [
        weeklyRow({ cardId: "A", weight: 4, lockedDenominator: 8 } as any),
        weeklyRow({ cardId: "B", weight: 4, lockedDenominator: 8 } as any),
      ],
      bound: [{ cardId: "A", weight: 4 }, { cardId: "B", weight: 4 }],
      exclusive: new Set(["A", "B"]),
    });
    await t.load();
    expect(tOf(t, "A")).toBe(0);
    expect(tOf(t, "B")).toBe(0);
  });

  it("未占满整号(e<1:w<D):余量可能是别人/未认领烧的,load 不回补", async () => {
    const t = makeTracker({
      rows: [weeklyRow({ weightedUsed: 500 })], // C 独享但 w=4 < N=8 → e=0.5
      bound: [{ cardId: "C", weight: 4 }],
      exclusive: new Set(["C"]),
    });
    await t.load();
    expect(tOf(t)).toBe(0); // share=4/8=0.5 < 1 → 不回补
  });
});
