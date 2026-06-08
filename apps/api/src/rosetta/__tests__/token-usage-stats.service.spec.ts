import { describe, expect, it } from "vitest";

import { TokenUsageStatsService } from "../token-usage-stats.service";
import { beijingDayKey } from "../../common/beijing-time";

// Minimal prisma stub: a single in-memory CardTokenUsage table that supports the
// findMany(where/select) shapes these query methods use.
function makeService(rows: any[]) {
  const cardTokenUsage = {
    findMany: async ({ where }: any) => {
      return rows.filter((r) => {
        if (where.accessKeyId && r.accessKeyId !== where.accessKeyId) return false;
        if (where.accountId != null && r.accountId !== where.accountId) return false;
        if (where.timestamp?.gte && r.timestamp < where.timestamp.gte) return false;
        return true;
      });
    },
  };
  return new TokenUsageStatsService({ cardTokenUsage } as any);
}

function row(over: Partial<any>): any {
  return {
    accessKeyId: "card-1",
    accountId: 1,
    modelKey: "gpt-5",
    bucket: "codex-gpt",
    status: 200,
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    rawTotalTokens: 110,
    totalTokens: 110,
    timestamp: new Date(),
    ...over,
  };
}

describe("TokenUsageStatsService.getHourlyFrequency", () => {
  it("buckets a card's calls into 24 Beijing hours of the day", async () => {
    // 2026-06-07T00:30:00Z = 08:30 Beijing; 2026-06-07T06:00:00Z = 14:00 Beijing
    const svc = makeService([
      row({ timestamp: new Date("2026-06-07T00:30:00Z"), totalTokens: 5 }),
      row({ timestamp: new Date("2026-06-07T00:45:00Z"), totalTokens: 7 }),
      row({ timestamp: new Date("2026-06-07T06:00:00Z"), totalTokens: 3 }),
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
    const svc = makeService([
      row({ accessKeyId: "card-1", timestamp: new Date("2026-06-07T00:30:00Z") }),
      row({ accessKeyId: "card-2", timestamp: new Date("2026-06-07T00:30:00Z") }),
    ]);
    const out = await svc.getHourlyFrequency({ accessKeyId: "card-1", days: 1 });
    expect(out.totalRequests).toBe(1);
    expect(await svc.getHourlyFrequency({ accessKeyId: "" })).toEqual({ days: 0, byHour: [], totalRequests: 0 });
  });

  it("scopes a card's frequency to one account when accountId is given (multi-provider binding)", async () => {
    // Same card bound on two providers/accounts; each provider's view must only
    // see that account's calls, not the card's global total.
    const svc = makeService([
      row({ accessKeyId: "card-x", accountId: 1, timestamp: new Date("2026-06-07T00:30:00Z") }),
      row({ accessKeyId: "card-x", accountId: 9, timestamp: new Date("2026-06-07T00:30:00Z") }),
    ]);
    expect((await svc.getHourlyFrequency({ accessKeyId: "card-x", accountId: 9, days: 1 })).totalRequests).toBe(1);
    expect((await svc.getHourlyFrequency({ accessKeyId: "card-x", accountId: 1, days: 1 })).totalRequests).toBe(1);
    // No accountId → card's global total (both accounts).
    expect((await svc.getHourlyFrequency({ accessKeyId: "card-x", days: 1 })).totalRequests).toBe(2);
  });
});

describe("TokenUsageStatsService.getCardUsageSummary", () => {
  it("scopes a card's usage to the requested account (multi-provider binding)", async () => {
    const today = new Date();
    // card-x is bound on anthropic (acct 1, 42400 tok) AND antigravity (acct 9, 999 tok).
    const svc = makeService([
      row({ accessKeyId: "card-x", accountId: 1, bucket: "anthropic-claude", totalTokens: 42400, timestamp: today }),
      row({ accessKeyId: "card-x", accountId: 9, bucket: "antigravity-gemini", totalTokens: 999, timestamp: today }),
    ]);
    // Antigravity view must NOT show anthropic's 42400.
    const anti = await svc.getCardUsageSummary({ accessKeyId: "card-x", accountId: 9, days: 7 });
    expect(anti.totals.totalTokens).toBe(999);
    expect(anti.totals.requests).toBe(1);
    const anth = await svc.getCardUsageSummary({ accessKeyId: "card-x", accountId: 1, days: 7 });
    expect(anth.totals.totalTokens).toBe(42400);
    expect(anth.totals.requests).toBe(1);
  });

  it("without accountId, sums all of a card's usage (back-compat)", async () => {
    const today = new Date();
    const svc = makeService([
      row({ accessKeyId: "card-x", accountId: 1, totalTokens: 100, timestamp: today }),
      row({ accessKeyId: "card-x", accountId: 9, totalTokens: 50, timestamp: today }),
    ]);
    expect((await svc.getCardUsageSummary({ accessKeyId: "card-x", days: 7 })).totals.totalTokens).toBe(150);
  });

  it("returns empty for a blank id", async () => {
    const svc = makeService([row({ accessKeyId: "card-x" })]);
    const out = await svc.getCardUsageSummary({ accessKeyId: "" });
    expect(out.totals.totalTokens).toBe(0);
    expect(out.daily).toEqual([]);
  });
});

describe("TokenUsageStatsService.getAccountUsageTrend", () => {
  it("returns a continuous daily token trend for one account", async () => {
    const today = new Date();
    const svc = makeService([
      row({ accountId: 7, totalTokens: 100, timestamp: today }),
      row({ accountId: 7, totalTokens: 50, timestamp: today }),
      row({ accountId: 9, totalTokens: 999, timestamp: today }), // other account → excluded
    ]);
    const out = await svc.getAccountUsageTrend({ accountId: 7, days: 7 });

    expect(out.accountId).toBe(7);
    expect(out.daily.length).toBeGreaterThanOrEqual(7);
    const todayKey = beijingDayKey(today);
    const todayRow = out.daily.find((d) => d.date === todayKey)!;
    expect(todayRow.totalTokens).toBe(150);
    expect(todayRow.requests).toBe(2);
    expect(out.totals.totalTokens).toBe(150);
    expect(out.totals.requests).toBe(2);
  });

  it("returns an empty trend for an invalid account id", async () => {
    const svc = makeService([]);
    const out = await svc.getAccountUsageTrend({ accountId: 0 });
    expect(out.accountId).toBe(0);
    expect(out.daily).toEqual([]);
    expect(out.totals).toEqual({ totalTokens: 0, requests: 0 });
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
        timestamp: now,
      }),
      // Codex: no cache → cache-write derives to 0.
      row({ bucket: "codex-gpt", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, rawTotalTokens: 110, totalTokens: 110, timestamp: now }),
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
