import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenUsageStatsService } from "../token-usage-stats.service";
import { beijingDayKey } from "../../../shared/common/beijing-time";

// Prisma stub with two tables backed by one row list:
//   - cardUsageHourly: powers summary / hourly-frequency / today / trend.
//     Reads hourStart + requests + token sums; scoped by the stable accountEmail.
//   - cardTokenUsage:  powers getAccountUsageTrend (still per-call raw, by accountId).
// A test row carries BOTH timestamp and hourStart (same instant) and requests
// (default 1), so it behaves like one call unless requests is overridden to model
// a pre-aggregated hour.
function makeService(rows: any[]) {
  const sinceOk = (val: any, gte: any) => !gte || val >= gte;
  const cardUsageHourly = {
    findMany: async ({ where }: any) =>
      rows.filter((r) => {
        if (where.accessKeyId && r.accessKeyId !== where.accessKeyId) return false;
        if (where.customerId != null && (r.customerId ?? "") !== where.customerId) return false;
        if (where.accountEmail != null && (r.accountEmail ?? "") !== where.accountEmail) return false;
        return sinceOk(r.hourStart, where.hourStart?.gte);
      }),
  };
  return new TokenUsageStatsService({ cardUsageHourly } as any);
}

function row(over: Partial<any>): any {
  const ts = (over as any).timestamp ?? (over as any).hourStart ?? new Date();
  return {
    accessKeyId: "card-1",
    accountId: 1,
    accountEmail: "",
    customerId: "",
    modelKey: "gpt-5",
    bucket: "codex-gpt",
    status: 200,
    requests: 1,
    failedRequests: 0,
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    rawTotalTokens: 110,
    totalTokens: 110,
    timestamp: ts,
    hourStart: ts,
    ...over,
  };
}

describe("TokenUsageStatsService.getHourlyFrequency", () => {
  // These tests use fixed 2026-06-07 timestamps with a relative `days` window, so
  // they must pin "now" to that day — otherwise the data ages out of the window
  // and every query returns 0 (date-rot). Scoped to this describe; the other
  // blocks use new Date() and stay on the real clock.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets a card's calls into 24 Beijing hours of the day", async () => {
    // T00:30:00Z = 08:30 Beijing; T06:00:00Z = 14:00 Beijing
    const todayStr = new Date().toISOString().split("T")[0];
    const svc = makeService([
      row({ hourStart: new Date(`${todayStr}T00:30:00Z`), requests: 1, totalTokens: 5 }),
      row({ hourStart: new Date(`${todayStr}T00:45:00Z`), requests: 1, totalTokens: 7 }),
      row({ hourStart: new Date(`${todayStr}T06:00:00Z`), requests: 1, totalTokens: 3 }),
    ]);
    const out = await svc.getHourlyFrequency({ accessKeyId: "card-1", days: 1 });

    expect(out.byHour).toHaveLength(24);
    expect(out.totalRequests).toBe(3);
    const h8 = out.byHour.find((b) => b.hour === 8)!;
    expect(h8.requests).toBe(2);
    expect(h8.totalTokens).toBe(12);
    const h14 = out.byHour.find((b) => b.hour === 14)!;
    expect(h14.requests).toBe(1);
    // Empty hours are present with zeros.
    expect(out.byHour.find((b) => b.hour === 3)!.requests).toBe(0);
  });

  it("only counts the requested card and returns empty for a blank id", async () => {
    const todayStr = new Date().toISOString().split("T")[0];
    const svc = makeService([
      row({ accessKeyId: "card-1", hourStart: new Date(`${todayStr}T00:30:00Z`) }),
      row({ accessKeyId: "card-2", hourStart: new Date(`${todayStr}T00:30:00Z`) }),
    ]);
    const out = await svc.getHourlyFrequency({ accessKeyId: "card-1", days: 1 });
    expect(out.totalRequests).toBe(1);
    expect(await svc.getHourlyFrequency({ accessKeyId: "" })).toEqual({ days: 0, byHour: [], totalRequests: 0 });
  });

  it("scopes a card's frequency to one account by accountEmail (multi-provider binding)", async () => {
    // Same card serves under two upstream accounts (one per provider); each
    // provider's view must only see that account's calls, scoped by accountEmail.
    const todayStr = new Date().toISOString().split("T")[0];
    const svc = makeService([
      row({ accessKeyId: "card-x", accountEmail: "anth@x.com", hourStart: new Date(`${todayStr}T00:30:00Z`) }),
      row({ accessKeyId: "card-x", accountEmail: "gem@x.com", hourStart: new Date(`${todayStr}T00:30:00Z`) }),
    ]);
    expect((await svc.getHourlyFrequency({ accessKeyId: "card-x", accountEmail: "gem@x.com", days: 1 })).totalRequests).toBe(1);
    expect((await svc.getHourlyFrequency({ accessKeyId: "card-x", accountEmail: "anth@x.com", days: 1 })).totalRequests).toBe(1);
    // No accountEmail → card's global total (both accounts).
    expect((await svc.getHourlyFrequency({ accessKeyId: "card-x", days: 1 })).totalRequests).toBe(2);
  });
});

describe("TokenUsageStatsService.getCardUsageSummary", () => {
  it("scopes a card's usage to the requested account by accountEmail (multi-provider binding)", async () => {
    const today = new Date();
    // card-x serves under anthropic (anth@x, 42400 tok) AND antigravity (gem@x, 999 tok).
    const svc = makeService([
      row({ accessKeyId: "card-x", accountEmail: "anth@x.com", bucket: "anthropic-claude", totalTokens: 42400, hourStart: today }),
      row({ accessKeyId: "card-x", accountEmail: "gem@x.com", bucket: "antigravity-gemini", totalTokens: 999, hourStart: today }),
    ]);
    const anti = await svc.getCardUsageSummary({ accessKeyId: "card-x", accountEmail: "gem@x.com", days: 7 });
    expect(anti.totals.totalTokens).toBe(999);
    expect(anti.totals.requests).toBe(1);
    const anth = await svc.getCardUsageSummary({ accessKeyId: "card-x", accountEmail: "anth@x.com", days: 7 });
    expect(anth.totals.totalTokens).toBe(42400);
    expect(anth.totals.requests).toBe(1);
  });

  it("without accountEmail, sums all of a card's usage (back-compat)", async () => {
    const today = new Date();
    const svc = makeService([
      row({ accessKeyId: "card-x", accountEmail: "anth@x.com", totalTokens: 100, hourStart: today }),
      row({ accessKeyId: "card-x", accountEmail: "gem@x.com", totalTokens: 50, hourStart: today }),
    ]);
    expect((await svc.getCardUsageSummary({ accessKeyId: "card-x", days: 7 })).totals.totalTokens).toBe(150);
  });

  it("sums multiple calls aggregated into one hourly row (requests > 1)", async () => {
    const today = new Date();
    const svc = makeService([
      row({ accessKeyId: "card-x", requests: 5, totalTokens: 500, hourStart: today }),
    ]);
    const out = await svc.getCardUsageSummary({ accessKeyId: "card-x", days: 7 });
    expect(out.totals.requests).toBe(5);
    expect(out.totals.totalTokens).toBe(500);
    expect(out.byModel[0].requests).toBe(5);
  });

  it("returns empty for a blank id", async () => {
    const svc = makeService([row({ accessKeyId: "card-x" })]);
    const out = await svc.getCardUsageSummary({ accessKeyId: "" });
    expect(out.totals.totalTokens).toBe(0);
    expect(out.daily).toEqual([]);
  });

  // Stable-identity scoping: the hourly table is keyed by accountEmail (no volatile
  // positional accountId), so usage survives pool reloads — the int gets reassigned
  // but the email doesn't, and a different account inheriting the int can't leak in.
  it("scopes by stable accountEmail (a different account on the same card does not leak)", async () => {
    const today = new Date();
    const svc = makeService([
      row({ accessKeyId: "card-x", accountEmail: "a@x.com", totalTokens: 100, hourStart: today }),
      row({ accessKeyId: "card-x", accountEmail: "a@x.com", totalTokens: 50, hourStart: today }),
      row({ accessKeyId: "card-x", accountEmail: "b@x.com", totalTokens: 999, hourStart: today }),
    ]);
    const out = await svc.getCardUsageSummary({ accessKeyId: "card-x", accountEmail: "a@x.com", days: 7 });
    expect(out.totals.totalTokens).toBe(150);
    expect(out.totals.requests).toBe(2);
  });
});

describe("TokenUsageStatsService.getTodayUsage", () => {
  it("splits today's billable tokens into net input / output / cache-write / cache-read per provider", async () => {
    const now = new Date();
    // Anthropic: net input 100 + output 260 + cache_creation 39000 + cache_read 3000
    //   rawTotal = 42360; billable = rawTotal − cacheRead + ceil(cacheRead/10) = 39660.
    //   cache_creation is derived as rawTotal − input − output − cacheRead = 39000.
    const svc = makeService([
      row({
        bucket: "anthropic-sonnet",
        inputTokens: 100,
        outputTokens: 260,
        cachedInputTokens: 3000,
        rawTotalTokens: 42360,
        totalTokens: 39660,
        hourStart: now,
      }),
      // Codex: no cache → cache-write derives to 0.
      row({ bucket: "codex-gpt", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, rawTotalTokens: 110, totalTokens: 110, hourStart: now }),
    ]);

    const out = await svc.getTodayUsage();

    expect(out.totalTokens).toBe(39770);
    expect(out.requests).toBe(2);
    expect(out.cacheWriteTokens).toBe(39000);
    expect(out.cacheReadTokens).toBe(3000);

    expect(out.byProvider.anthropic).toEqual({
      tokens: 39660,
      requests: 1,
      inputTokens: 100,
      outputTokens: 260,
      cacheWriteTokens: 39000,
      cacheReadTokens: 3000,
    });
    expect(out.byProvider.codex.cacheWriteTokens).toBe(0);
    expect(out.byProvider.codex.tokens).toBe(110);
  });
});

describe("TokenUsageStatsService.getUsageTrend", () => {
  it("按北京日聚合全部卡用量,按 provider 拆分 + 连续填零", async () => {
    const today = new Date();
    const svc = makeService([
      row({ bucket: "anthropic-claude", totalTokens: 300, hourStart: today }),
      row({ bucket: "codex-gpt", totalTokens: 120, hourStart: today }),
      row({ bucket: "anthropic-claude", totalTokens: 200, hourStart: today, requests: 2 }),
    ]);

    const out = await svc.getUsageTrend({ days: 7 });

    expect(out.days).toBe(7);
    expect(out.daily.length).toBeGreaterThanOrEqual(7); // 含当天,连续填零
    expect(out.totals.totalTokens).toBe(620);
    expect(out.totals.requests).toBe(4); // 1 + 1 + 2
    const todayKey = beijingDayKey(today);
    const td = out.daily.find((d) => d.date === todayKey)!;
    expect(td.anthropic).toBe(500); // 300 + 200
    expect(td.codex).toBe(120);
    expect(td.totalTokens).toBe(620);
  });

  it("无用量 → 全零、天数连续", async () => {
    const svc = makeService([]);
    const out = await svc.getUsageTrend({ days: 7 });
    expect(out.daily.length).toBeGreaterThanOrEqual(7);
    expect(out.totals).toEqual({ totalTokens: 0, requests: 0 });
    expect(out.daily.every((d) => d.totalTokens === 0)).toBe(true);
  });
});

describe("TokenUsageStatsService.cleanupHourly", () => {
  it("删除 ~60 天前的小时聚合行(hourStart < cutoff)", async () => {
    const deleteMany = vi.fn(async () => ({ count: 3 }));
    const svc = new TokenUsageStatsService({ cardUsageHourly: { deleteMany } } as any);

    await svc.cleanupHourly();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const arg = (deleteMany.mock.calls[0] as any)[0];
    expect(arg.where.hourStart.lt).toBeInstanceOf(Date);
    // 截止点约在 60 天前(按北京日零点对齐,容差 2 天)。
    const cutoffMs = (arg.where.hourStart.lt as Date).getTime();
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - sixtyDaysAgo)).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("删 0 行不报错", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const svc = new TokenUsageStatsService({ cardUsageHourly: { deleteMany } } as any);
    await expect(svc.cleanupHourly()).resolves.toBeUndefined();
  });
});
