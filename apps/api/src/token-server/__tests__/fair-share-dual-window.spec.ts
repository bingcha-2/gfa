import { describe, expect, it } from "vitest";

import { FairShareTracker } from "../fair-share-tracker";

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5h

function makeTracker(now: () => number) {
  return new FairShareTracker({
    getAccountPlanType: () => "pro",
    getBoundCardIds: () => [],
    getCardWeight: () => 1,
    accountShareCapacity: 8,
    now,
  });
}

// 验证现状缺口:fair-share 只有一个 5h 窗口,周维度无处安放。
// 御三家(Anthropic/Codex)是「5h + 周」双限,但现状每 5h 就清空 perCard,
// 于是「这张卡这一周用了多少」永远统计不全 → 周的「已用」凑不满 → 周限额形同虚设。
describe("FairShareTracker 双窗口(5h + 周)— 现状缺口验证", () => {
  it("周维度用量应跨 5h 边界继续累计(现状每 5h 清零 → 周限额无法执行)", () => {
    let now = 1_700_000_000_000;
    const t = makeTracker(() => now);

    t.recordUsage(1, "c1", "codex-gpt", 100_000, 0, 0); // 第 1 个 5h 段:周累计 100k
    now += WINDOW_MS + 1; // 跨过 5h 边界
    t.recordUsage(1, "c1", "codex-gpt", 100_000, 0, 0); // 同一周第 2 段:周累计应 200k

    // 5h 维度跨边界清零是对的;但「周」维度不该清,应累计 200k。
    // 现状根本没有「周」维度 —— slow 视角只会回退到 5h(=最近一段 100k)。
    const weekly = t.getBucketStateForTesting(1, "codex-gpt", "slow");
    expect(weekly?.perCard.c1).toBe(200_000);
  });

  it("双窗取 min:5h 充裕但周耗尽 → checkFairShare 因周拦截(现状只看 5h → 漏放行)", () => {
    const t = makeTracker(() => 1_700_000_000_000);
    t.recordUsage(1, "c1", "codex-gpt", 100_000, 0, 0); // fast+slow 各累计 100k

    // 周 fraction=2% → 周 budget≈102k,单卡份额(1/8)≈12.75k,本卡已用 100k → 周维度爆掉。
    t.updateBudgetEstimate(1, "codex-gpt", 0.02, "slow");
    // 5h 维度无紧张信号(lastFraction 默认 1.0 → 充裕,会放行)。

    const check = t.checkFairShare(1, "c1", "codex-gpt");
    expect(check.allowed).toBe(false); // 应取更紧的「周」维度拦截
    expect(check.reason).toMatch(/周/);
  });

  // ── 一致性守护(对称重构已实现,这里锁死防退化)──────────────────────
  it("对齐绑定账号重置:fast 对齐 5h reset(reset−5h),slow 对齐周 reset(reset−7d)", () => {
    const HOUR = 60 * 60 * 1000;
    const now = 1_700_000_000_000;
    const t = makeTracker(() => now);
    const hourlyReset = now + 2 * HOUR; // 上游 5h 窗口 2h 后重置
    const weeklyReset = now + 3 * 24 * HOUR; // 上游周窗口 3 天后重置

    t.syncWindow(1, "codex-gpt", hourlyReset, "fast");
    t.syncWindow(1, "codex-gpt", weeklyReset, "slow");

    expect(t.getBucketStateForTesting(1, "codex-gpt", "fast")?.windowStart).toBe(hourlyReset - 5 * HOUR);
    expect(t.getBucketStateForTesting(1, "codex-gpt", "slow")?.windowStart).toBe(weeklyReset - 7 * 24 * HOUR);
  });

  it("中途重置·各窗独立:fast 跨 5h 清零、同期 slow 继续累计;slow 跨 7d 才清零", () => {
    const DAY = 24 * 60 * 60 * 1000;
    let now = 1_700_000_000_000;
    const t = makeTracker(() => now);

    t.recordUsage(1, "c1", "codex-gpt", 50_000, 0, 0);
    now += WINDOW_MS + 1; // 跨过 5h 边界
    t.recordUsage(1, "c1", "codex-gpt", 50_000, 0, 0);
    expect(t.getBucketStateForTesting(1, "codex-gpt", "fast")?.perCard.c1).toBe(50_000); // fast 清零重来
    expect(t.getBucketStateForTesting(1, "codex-gpt", "slow")?.perCard.c1).toBe(100_000); // slow 仍累计

    now += 7 * DAY; // 自 slow 起点已逾 7 天
    t.recordUsage(1, "c1", "codex-gpt", 20_000, 0, 0);
    expect(t.getBucketStateForTesting(1, "codex-gpt", "slow")?.perCard.c1).toBe(20_000); // slow 跨 7d 清零
  });

  // ── 双窗判定:对称 / 退化 / ≥90% 逐窗 / min 取值 ────────────────────────
  it("双窗取 min(对称):周充裕但 5h 耗尽 → 因 5h 拦", () => {
    const t = makeTracker(() => 1_700_000_000_000);
    t.recordUsage(1, "c1", "codex-gpt", 100_000, 0, 0);
    t.updateBudgetEstimate(1, "codex-gpt", 0.02, "fast"); // 5h 耗尽;周无信号(默认充裕)
    const check = t.checkFairShare(1, "c1", "codex-gpt");
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/5h/);
  });

  it("antigravity 退化:周无信号(lastFraction 默认 1)→ 不误拦,拦的只可能是 5h", () => {
    const t = makeTracker(() => 1_700_000_000_000);
    t.recordUsage(1, "c1", "antigravity-gemini", 100_000, 0, 0);
    t.updateBudgetEstimate(1, "antigravity-gemini", 0.5, "fast"); // 只喂 5h
    const check = t.checkFairShare(1, "c1", "antigravity-gemini");
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/5h/); // 周维度从不喂信号 → 绝不会因「周」拦
  });

  it("≥90% 放行逐窗:5h 在放行区(95%)但周紧(2%)→ 仍取周拦", () => {
    const t = makeTracker(() => 1_700_000_000_000);
    t.recordUsage(1, "c1", "codex-gpt", 100_000, 0, 0);
    t.updateBudgetEstimate(1, "codex-gpt", 0.95, "fast"); // 5h 放行区
    t.updateBudgetEstimate(1, "codex-gpt", 0.02, "slow"); // 周紧
    const check = t.checkFairShare(1, "c1", "codex-gpt");
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/周/);
  });

  it("两窗都在放行区 → remainingFraction 取两者更小的 fraction", () => {
    const t = makeTracker(() => 1_700_000_000_000);
    t.recordUsage(1, "c1", "codex-gpt", 1_000, 0, 0);
    t.updateBudgetEstimate(1, "codex-gpt", 0.95, "fast");
    t.updateBudgetEstimate(1, "codex-gpt", 0.92, "slow");
    const check = t.checkFairShare(1, "c1", "codex-gpt");
    expect(check.allowed).toBe(true);
    expect(check.remainingFraction).toBeCloseTo(0.92, 5); // min(0.95, 0.92)
  });

  it("血条 getCardQuotaFractions 取 min:周更紧 → 返回周的 fraction 与 resetAt(现状只给 5h)", () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const now = 1_700_000_000_000;
    const t = makeTracker(() => now);
    t.recordUsage(1, "c1", "codex-gpt", 1_000, 0, 0);
    t.updateBudgetEstimate(1, "codex-gpt", 0.95, "fast"); // 5h 充裕
    t.updateBudgetEstimate(1, "codex-gpt", 0.92, "slow"); // 周更紧(仍在放行区)
    const weeklyReset = now + 3 * DAY;
    t.syncWindow(1, "codex-gpt", weeklyReset, "slow");

    const q = t.getCardQuotaFractions(1, "c1");
    expect(q["codex-gpt"].fraction).toBeCloseTo(0.92, 5); // min(0.95, 0.92) → 周
    expect(q["codex-gpt"].resetAt).toBe(weeklyReset); // 跟随更紧的「周」窗口
  });

  it("并发累加一致:多卡交替记账,各卡 fast/slow 独立且一致累计、互不串号", () => {
    const t = makeTracker(() => 1_700_000_000_000);
    for (let i = 0; i < 100; i++) {
      t.recordUsage(1, "c1", "codex-gpt", 100, 0, 0);
      t.recordUsage(1, "c2", "codex-gpt", 200, 0, 0);
      t.recordUsage(1, "c3", "codex-gpt", 300, 0, 0);
    }
    const fast = t.getBucketStateForTesting(1, "codex-gpt", "fast");
    const slow = t.getBucketStateForTesting(1, "codex-gpt", "slow");
    expect(fast?.perCard).toEqual({ c1: 10_000, c2: 20_000, c3: 30_000 });
    expect(slow?.perCard).toEqual({ c1: 10_000, c2: 20_000, c3: 30_000 }); // slow 与 fast 同步
    expect(fast?.totalUsed).toBe(60_000);
  });
});
