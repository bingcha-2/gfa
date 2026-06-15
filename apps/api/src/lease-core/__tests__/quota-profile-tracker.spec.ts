import { afterEach, describe, expect, it, vi } from "vitest";

import { QuotaProfileTracker, DECAY_TAU_5H_MS } from "../quota-profile-tracker";

const NOW = 1_700_000_000_000;

// In-memory stand-in for prisma.quotaProfile (composite id provider+planType+family).
function makePrisma() {
  const store = new Map<string, any>();
  const upsert = vi.fn(async ({ where, create, update }: any) => {
    const id = where.provider_planType_family;
    const k = `${id.provider}:${id.planType}:${id.family}`;
    const existing = store.get(k);
    store.set(k, existing ? { ...existing, ...update } : { ...create });
    return store.get(k);
  });
  const findMany = vi.fn(async () => [...store.values()]);
  return { prisma: { quotaProfile: { upsert, findMany } }, store, upsert, findMany };
}

let active: QuotaProfileTracker | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

describe("QuotaProfileTracker (SQL-backed)", () => {
  it("records samples and computes the (decayed) weighted median budget", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma, { now: () => NOW });
    active = tracker;

    // (product, planType, family, totalUsedWeighted, fraction, isWeekly)
    tracker.recordSample("antigravity", "ultra", "claude", 200000, 0.2, false); // 200000/0.8 = 250000
    tracker.recordSample("antigravity", "ultra", "claude", 300000, 0.1, false); // 300000/0.9 = 333333
    tracker.recordSample("antigravity", "ultra", "claude", 180000, 0.4, false); // 180000/0.6 = 300000

    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile?.samples5h).toBe(3);
    // Same timestamp → equal weights → classic median of [250000, 300000, 333333].
    expect(tracker.getLearnedBudget5h("antigravity", "ultra", "claude")).toBe(300000);
  });

  it("drops samples with no real fraction (null) — never treats 'no data' as 0%", () => {
    const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
    active = tracker;
    tracker.recordSample("antigravity", "ultra", "claude", 200000, null, false);
    expect(tracker.getProfile("antigravity", "ultra", "claude")).toBeNull();
  });

  it("drops low-consumed samples (consumed < 0.10) but accepts the 0.10 boundary", () => {
    const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
    active = tracker;
    tracker.recordSample("antigravity", "ultra", "claude", 200000, 0.95, false); // consumed 0.05 → drop
    expect(tracker.getProfile("antigravity", "ultra", "claude")).toBeNull();
    tracker.recordSample("antigravity", "ultra", "claude", 200000, 0.9, false); // consumed 0.10 → keep (float-safe)
    expect(tracker.getProfile("antigravity", "ultra", "claude")?.samples5h).toBe(1);
  });

  it("ignores samples below MIN_SAMPLE_THRESHOLD (10_000)", () => {
    const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
    active = tracker;
    tracker.recordSample("antigravity", "ultra", "claude", 5000, 0.5, false);
    expect(tracker.getProfile("antigravity", "ultra", "claude")).toBeNull();
  });

  it("tracks weekly and 5h samples independently", () => {
    const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
    active = tracker;
    tracker.recordSample("antigravity", "ultra", "claude", 200000, 0.2, true);
    tracker.recordSample("antigravity", "ultra", "claude", 300000, 0.2, false);
    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile?.samplesWeekly).toBe(1);
    expect(profile?.samples5h).toBe(1);
    expect(tracker.getLearnedBudget5h("antigravity", "ultra", "claude")).toBe(375000); // 300000/0.8
  });

  it("time-decayed median converges DOWN on a regime change (100M → 80M)", () => {
    let now = NOW;
    const tracker = new QuotaProfileTracker(undefined, { now: () => now });
    active = tracker;
    // Old regime: estimated 100M (80M used at 20% consumed).
    for (let i = 0; i < 10; i++) tracker.recordSample("anthropic", "max", "claude", 80_000_000, 0.2, false);
    expect(tracker.getLearnedBudget5h("anthropic", "max", "claude")).toBe(100_000_000);
    // ~2τ later, official cut to 80M (64M used at 20% consumed).
    now = NOW + 2 * DECAY_TAU_5H_MS;
    for (let i = 0; i < 10; i++) tracker.recordSample("anthropic", "max", "claude", 64_000_000, 0.2, false);
    const b = tracker.getLearnedBudget5h("anthropic", "max", "claude");
    expect(b).toBeLessThan(95_000_000); // no longer pinned by the old majority
    expect(b).toBeGreaterThan(75_000_000);
  });

  it("read-time recompute: a fresh low sample overtakes an old high one as the clock advances", () => {
    let now = NOW;
    const tracker = new QuotaProfileTracker(undefined, { now: () => now });
    active = tracker;
    tracker.recordSample("anthropic", "max", "claude", 80_000_000, 0.2, false); // 100M @ NOW
    now = NOW + 2 * DECAY_TAU_5H_MS;
    tracker.recordSample("anthropic", "max", "claude", 64_000_000, 0.2, false); // 80M @ NOW+2τ (much fresher)
    // At read time the 2τ-old 100M sample is down-weighted (e^-2) vs the fresh 80M.
    const b = tracker.getLearnedBudget5h("anthropic", "max", "claude");
    expect(b).toBe(80_000_000);
  });

  it("flush() upserts only dirty profiles, then is a no-op until changed again", async () => {
    const { prisma, upsert } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma, { now: () => NOW });
    active = tracker;
    tracker.recordSample("codex", "pro", "gpt", 240000, 0.2, false);
    await tracker.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]![0];
    expect(call.where.provider_planType_family).toEqual({ provider: "codex", planType: "pro", family: "gpt" });
    expect(call.create.window5h).toBe(300000); // 240000/0.8

    await tracker.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("round-trips through prisma: flush then load into a fresh tracker", async () => {
    const { prisma, store } = makePrisma();
    const t1 = new QuotaProfileTracker(prisma, { now: () => NOW });
    t1.recordSample("anthropic", "max", "claude", 240000, 0.2, false); // 240000/0.8 = 300000
    t1.recordSample("anthropic", "max", "claude", 400000, 0.5, true); // 400000/0.5 = 800000 weekly
    await t1.flush();
    t1.destroy();

    expect(store.size).toBe(1);

    const t2 = new QuotaProfileTracker(prisma, { now: () => NOW });
    active = t2;
    await t2.load();
    expect(t2.getLearnedBudget5h("anthropic", "max", "claude")).toBe(300000);
    const profile = t2.getProfile("anthropic", "max", "claude");
    expect(profile?.history5h.map((s) => s.v)).toEqual([300000]);
    expect(profile?.historyWeekly.map((s) => s.v)).toEqual([800000]);
    expect(profile?.samples5h).toBe(1);
    expect(profile?.samplesWeekly).toBe(1);
  });

  it("load() upgrades legacy bare number[] history to {v,t} (back-compat)", async () => {
    const { prisma, store } = makePrisma();
    store.set("anthropic:max:claude", {
      provider: "anthropic", planType: "max", family: "claude",
      window5h: 300000, weekly: 0, samples5h: 1, samplesWeekly: 0,
      history5h: JSON.stringify([300000]), // legacy number[]
      historyWeekly: "[]", lastUpdatedAt: BigInt(NOW),
    });
    const t = new QuotaProfileTracker(prisma, { now: () => NOW });
    active = t;
    await t.load();
    const p = t.getProfile("anthropic", "max", "claude");
    expect(p?.history5h.length).toBe(1);
    expect(p?.history5h[0].v).toBe(300000);
    expect(Number.isFinite(p?.history5h[0].t)).toBe(true); // got a fallback timestamp
  });

  it("destroy() stops the flush timer", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma, { now: () => NOW });
    const spy = vi.spyOn(globalThis, "clearInterval");
    tracker.destroy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no-ops gracefully without a prisma client (unit/test wiring)", async () => {
    const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
    active = tracker;
    tracker.recordSample("codex", "pro", "gpt", 240000, 0.2, false);
    await expect(tracker.flush()).resolves.toBeUndefined();
    await expect(tracker.load()).resolves.toBeUndefined();
    expect(tracker.getLearnedBudget5h("codex", "pro", "gpt")).toBe(300000);
  });

  // ── 周/5h 换算比 R(决策②:周样本养够前一律默认 5)─────────────────────────────
  describe("getWeeklyToShortRatio (weekly trust gate)", () => {
    // Feed enough weekly samples (≥ MIN_WEEKLY_SAMPLES=8, effective ≥ 5) to trust learned R.
    function feedWeekly(t: QuotaProfileTracker, used: number, frac: number, n = 8) {
      for (let i = 0; i < n; i++) t.recordSample("anthropic", "max", "claude", used, frac, true);
    }

    it("过渡期:周样本不足(<8)→ 全局默认 5", () => {
      const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
      active = tracker;
      tracker.recordSample("anthropic", "max", "claude", 80000, 0.2, false); // 5h = 100000
      tracker.recordSample("anthropic", "max", "claude", 400000, 0.2, true); // 1 weekly sample
      expect(tracker.getWeeklyToShortRatio("anthropic", "max", "claude")).toBe(5);
    });

    it("周样本养够后返回 weekly/5h", () => {
      const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
      active = tracker;
      tracker.recordSample("anthropic", "max", "claude", 80000, 0.2, false); // 5h = 100000
      feedWeekly(tracker, 400000, 0.2); // weekly = 500000 → R = 5
      expect(tracker.getWeeklyToShortRatio("anthropic", "max", "claude")).toBeCloseTo(5, 5);
    });

    it("无学习数据 → 全局默认 5", () => {
      const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
      active = tracker;
      expect(tracker.getWeeklyToShortRatio("anthropic", "max", "claude")).toBe(5);
    });

    it("比值越界被夹到 [4.235,30]", () => {
      const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
      active = tracker;
      tracker.recordSample("anthropic", "max", "claude", 80000, 0.2, false); // 5h = 100000
      feedWeekly(tracker, 9000000, 0.1); // weekly = 10,000,000 → 比值 100 → 夹到 30
      expect(tracker.getWeeklyToShortRatio("anthropic", "max", "claude")).toBe(30);
    });

    it("learned ratios below 4.235 are floored", () => {
      const tracker = new QuotaProfileTracker(undefined, { now: () => NOW });
      active = tracker;
      tracker.recordSample("anthropic", "max", "claude", 80000, 0.2, false); // 5h = 100000
      feedWeekly(tracker, 160000, 0.2); // weekly = 200000 → R = 2 → 夹到 4.235
      expect(tracker.getWeeklyToShortRatio("anthropic", "max", "claude")).toBe(4.235);
    });
  });
});
