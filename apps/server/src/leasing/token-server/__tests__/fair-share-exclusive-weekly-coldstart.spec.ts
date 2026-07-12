import { afterEach, describe, expect, it } from "vitest";

import { FairShareTracker } from "../fair-share-tracker";

/**
 * 复现:未超卖的「独享」号,母号真实周剩 33%(控制台口径),但客户端「号·周窗口」血条显 100%。
 *
 * 独享个人血条 = personalFraction = (e − T)/e,不拿母号有效缩放值冒充个人消耗。
 * 号未超卖 → 只这一张卡,w=N=8 → D=8 → e=1.0(独占整号)。若从窗口 reset 起连续归因,
 * 这张卡自己烧的 67% 会累进 T=0.67 → 血条 (1−0.67)/1=33%,与母号一致(见「对照」用例)。
 *
 * BUG:周窗口 7 天,若服务端在这 7 天中途重启 / FairShareWindow 行被清而冷重建 tracker,
 * 首个上游周快照(此刻已是 0.33)会被「冷启动采纳基线不归因」(applySnapshot §3a)当作低水位,
 * T 归零 → 血条 (1−0)/1 = 100%。5h 窗口每 5h reset 会自愈,周窗口这一整周都对不上。
 */

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const ACC = 1;
const BUCKET = "anthropic-claude";

const trackers: FairShareTracker[] = [];
afterEach(() => {
  while (trackers.length) trackers.pop()?.destroy();
});

function makeExclusiveTracker(now: () => number): FairShareTracker {
  const t = new FairShareTracker({
    getCardWeight: () => 8, // 独享:w = 号总席位 N
    getBoundCardWeights: () => [{ cardId: "C", weight: 8 }], // 号上只有这一张卡(未超卖)
    getSeatCapacity: () => 8,
    isExclusive: (cardId) => cardId === "C",
    trackWeekly: true,
    provider: "anthropic",
    now,
  });
  trackers.push(t);
  return t;
}

const weeklyPct = (t: FairShareTracker): number =>
  Math.round((t.getCardWeeklyQuotaFractions(ACC, "C")[BUCKET]?.fraction ?? -1) * 100);
const weeklyPersonalPct = (t: FairShareTracker): number =>
  Math.round((t.getCardWeeklyQuotaFractions(ACC, "C")[BUCKET]?.personalFraction ?? -1) * 100);

describe("独享周窗口:母号真实 33% → 血条应也 33%(修复后)", () => {
  it("冷启动/重启后首个周快照 0.33 → 真独占号回补 T=0.67 → 血条 = 母号真实 33%(不再虚高 100%)", () => {
    const t = makeExclusiveTracker(() => T);
    const weeklyReset = T + (3 * 24 + 3) * HOUR; // 「3天3h后恢复」

    // 号在过去几天已被这张独享卡自己烧到周剩 33%;此刻服务端刚(冷)建 weekly tracker,
    // 首个上游周快照 = 0.33 到达 → primed=false。号上只有这一张卡且占满整号(e=1),
    // 已烧的 67% 归属无歧义 → 回补 T=0.67。
    t.applyWeeklyAccountQuotaSnapshot(ACC, BUCKET, 0.33, weeklyReset);

    // 修复前:T=0 → 血条 100%(对不上)。修复后:T=0.67 → 血条 (1−0.67)/1 = 33%,与母号一致。
    expect(weeklyPct(t)).toBe(33);
    expect(weeklyPersonalPct(t)).toBe(33);
  });

  it("对照:未重启、从 reset 起连续归因 → 同一张独享卡血条正确显 33%(与母号一致)", () => {
    const t = makeExclusiveTracker(() => T);
    const weeklyReset = T + 7 * 24 * HOUR;

    // 窗口 reset,基线 fresh=1.0(满血)。
    t.applyWeeklyAccountQuotaSnapshot(ACC, BUCKET, 1.0, weeklyReset);
    // 这张卡自己烧额度(号唯一消费者)。
    t.recordUsage(ACC, "C", BUCKET, 1_000_000, 100_000, 0, "claude-opus-4-8");
    // 上游周快照跌到 0.33:Δ=0.67 全归因给唯一消费者 C。
    t.applyWeeklyAccountQuotaSnapshot(ACC, BUCKET, 0.33, weeklyReset);

    expect(weeklyPct(t)).toBe(33);
    expect(weeklyPersonalPct(t)).toBe(33);
  });
});

/**
 * 对照:拼车(非独享)在同样的冷启动下 **没有** 母号级虚高。
 * 非独享 bloodBar 走 scale 护栏:scale = min(1, 母号真实余量 / Σ各人剩余),
 * 使 Σ(各人展示剩余) 恒 ≤ 母号真实值。冷启动丢历史只会把那段未认领消耗「按份额摊平」
 * 到各人身上(闲卡被低估、重度用户被高估),但没有任何一张卡会 100% 而母号 33%。
 */
function makeSharedTracker(now: () => number, bound: Array<{ cardId: string; weight: number }>): FairShareTracker {
  const t = new FairShareTracker({
    getCardWeight: (id) => bound.find((b) => b.cardId === id)?.weight ?? 1,
    getBoundCardWeights: () => bound,
    getSeatCapacity: () => 8, // N=8
    isExclusive: () => false, // 拼车:全非独享
    trackWeekly: true,
    provider: "anthropic",
    now,
  });
  trackers.push(t);
  return t;
}
const sharedWeeklyPct = (t: FairShareTracker, card: string): number =>
  Math.round((t.getCardWeeklyQuotaFractions(ACC, card)[BUCKET]?.fraction ?? -1) * 100);

describe("拼车周窗口:scale 护栏封顶,无母号级虚高(对照)", () => {
  it("未超卖:冷启动首个快照 0.33 → 各卡被摊到 66%,无一张显 100%;Σ展示剩余 = 母号 33%", () => {
    // 4 张 w=1,D=max(N=8, Σw=4)=8 → 各 e=1/8=0.125,Σe=0.5。
    const cards = ["A", "B", "C", "D"].map((cardId) => ({ cardId, weight: 1 }));
    const t = makeSharedTracker(() => T, cards);
    t.applyWeeklyAccountQuotaSnapshot(ACC, BUCKET, 0.33, T + (3 * 24 + 3) * HOUR);

    // scale = 0.33 / Σ(e−T)=0.33/0.5 = 0.66 → 各卡展示 66%(≠100%,被封顶)。
    for (const { cardId } of cards) expect(sharedWeeklyPct(t, cardId)).toBe(66);
    // 关键不变式:Σ(各人展示剩余) = 0.66×0.125×4 = 0.33 = 母号真实值,永不虚高。
    const sumShown = cards.reduce((s, { cardId }) => s + (sharedWeeklyPct(t, cardId) / 100) * 0.125, 0);
    expect(Math.round(sumShown * 100)).toBe(33);
  });

  it("超卖:10 张 w=1(D=Σw=10)冷启动 → 每卡恰好显 33%,与母号一致", () => {
    const cards = Array.from({ length: 10 }, (_, i) => ({ cardId: `S${i}`, weight: 1 }));
    const t = makeSharedTracker(() => T, cards);
    t.applyWeeklyAccountQuotaSnapshot(ACC, BUCKET, 0.33, T + (3 * 24 + 3) * HOUR);

    // 超卖 Σe=1.0 → scale=0.33/1.0=0.33 → 各卡展示 33%(=母号),无虚高。
    for (const { cardId } of cards) expect(sharedWeeklyPct(t, cardId)).toBe(33);
  });
});
