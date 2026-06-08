import { afterEach, describe, expect, it, vi } from "vitest";

import { QuotaProfileTracker } from "../quota-profile-tracker";

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
  it("records 429 exhaustion events and computes the median budget", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma);
    active = tracker;

    // (product, planType, family, totalUsedWeighted, lastFraction, isWeekly)
    tracker.recordExhaustion("antigravity", "ultra", "claude", 200000, 0.2, false); // 200000/0.8 = 250000
    tracker.recordExhaustion("antigravity", "ultra", "claude", 300000, 0.1, false); // 300000/0.9 = 333333
    tracker.recordExhaustion("antigravity", "ultra", "claude", 180000, 0.4, false); // 180000/0.6 = 300000

    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile?.samples5h).toBe(3);
    expect(profile?.window5h).toBe(300000); // median of [250000, 333333, 300000]
    expect(tracker.getLearnedBudget5h("antigravity", "ultra", "claude")).toBe(300000);
  });

  it("falls back to totalUsed when fraction is close to 1", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma);
    active = tracker;
    tracker.recordExhaustion("antigravity", "ultra", "claude", 150000, 0.95, false);
    expect(tracker.getProfile("antigravity", "ultra", "claude")?.window5h).toBe(150000);
  });

  it("ignores samples below MIN_SAMPLE_THRESHOLD (10_000)", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma);
    active = tracker;
    tracker.recordExhaustion("antigravity", "ultra", "claude", 5000, 0.5, false);
    expect(tracker.getProfile("antigravity", "ultra", "claude")).toBeNull();
  });

  it("tracks weekly and 5h samples independently", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma);
    active = tracker;
    tracker.recordExhaustion("antigravity", "ultra", "claude", 200000, 0.2, true);
    tracker.recordExhaustion("antigravity", "ultra", "claude", 300000, 0.2, false);
    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile?.samplesWeekly).toBe(1);
    expect(profile?.samples5h).toBe(1);
    expect(profile?.weekly).toBe(250000); // 200000/0.8
    expect(profile?.window5h).toBe(375000); // 300000/0.8
  });

  it("flush() upserts only dirty profiles, then is a no-op until changed again", async () => {
    const { prisma, upsert } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma);
    active = tracker;
    tracker.recordExhaustion("codex", "pro", "gpt", 240000, 0.2, false);
    await tracker.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]![0];
    expect(call.where.provider_planType_family).toEqual({ provider: "codex", planType: "pro", family: "gpt" });
    expect(call.create.window5h).toBe(300000); // 240000/0.8

    // Nothing changed → no further upserts.
    await tracker.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("round-trips through prisma: flush then load into a fresh tracker", async () => {
    const { prisma, store } = makePrisma();
    const t1 = new QuotaProfileTracker(prisma);
    t1.recordExhaustion("anthropic", "max", "claude", 240000, 0.2, false); // 240000/0.8 = 300000
    t1.recordExhaustion("anthropic", "max", "claude", 400000, 0.5, true); // 400000/0.5 = 800000 weekly
    await t1.flush();
    t1.destroy();

    expect(store.size).toBe(1); // one composite row

    const t2 = new QuotaProfileTracker(prisma);
    active = t2;
    await t2.load();
    expect(t2.getLearnedBudget5h("anthropic", "max", "claude")).toBe(300000);
    const profile = t2.getProfile("anthropic", "max", "claude");
    expect(profile?.weekly).toBe(800000);
    expect(profile?.history5h).toEqual([300000]);
    expect(profile?.historyWeekly).toEqual([800000]);
    expect(profile?.samples5h).toBe(1);
    expect(profile?.samplesWeekly).toBe(1);
  });

  it("destroy() stops the flush timer", () => {
    const { prisma } = makePrisma();
    const tracker = new QuotaProfileTracker(prisma);
    const spy = vi.spyOn(globalThis, "clearInterval");
    tracker.destroy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no-ops gracefully without a prisma client (unit/test wiring)", async () => {
    const tracker = new QuotaProfileTracker();
    active = tracker;
    tracker.recordExhaustion("codex", "pro", "gpt", 240000, 0.2, false);
    await expect(tracker.flush()).resolves.toBeUndefined();
    await expect(tracker.load()).resolves.toBeUndefined();
    // In-memory learning still works even without persistence.
    expect(tracker.getLearnedBudget5h("codex", "pro", "gpt")).toBe(300000);
  });
});
