import { describe, expect, it } from "vitest";

import { rollupProviderStats, RemoteStatsService } from "../remote-stats.service";

const antigravityStatus = {
  mode: "remote-token-server",
  totalLeases: 10,
  totalReports: 8,
  activeLeases: 2,
  accounts: { total: 3, enabled: 2, withProject: 2 },
  daily: { tokensUsed: 1500 },
  models: [
    { key: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", bucket: "gemini" },
    { key: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 Thinking", bucket: "opus" },
  ],
  quota: {
    accounts: [
      { id: 1, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.4 } },
      { id: 2, enabled: true, quotaStatus: "cooling", modelQuotaFractions: { "gemini-2.5-pro": 0.9 } },
      { id: 3, enabled: false, quotaStatus: "error", modelQuotaFractions: {} },
    ],
  },
};

describe("rollupProviderStats", () => {
  it("rolls up account health, usage totals, and per-model supply metrics", () => {
    const r = rollupProviderStats("antigravity", antigravityStatus);

    expect(r.id).toBe("antigravity");
    expect(r.accounts).toMatchObject({ total: 3, enabled: 2, ok: 1, cooling: 1, error: 1, exhausted: 0 });
    expect(r.usage).toMatchObject({ dailyTokensUsed: 1500, activeLeases: 2, totalLeases: 10 });

    const gemini = r.models.find((m) => m.key === "gemini-2.5-pro")!;
    // Enabled accounts: #1 (ok, 0.4) and #2 (cooling, 0.9). #3 is disabled.
    expect(gemini.poolSize).toBe(2);
    // Only #1 can serve right now: #2 is cooling (quotaStatus !== ok).
    expect(gemini.available).toBe(1);
    expect(gemini.withData).toBe(2);
    expect(gemini.lowestRemaining).toBeCloseTo(0.4, 5); // water level = min, not max
    expect(gemini.medianRemaining).toBeCloseTo(0.65, 5);
    expect(gemini.bestRemaining).toBeCloseTo(0.9, 5); // kept as secondary
    expect(gemini.lowCount).toBe(0); // none below 20%

    const opus = r.models.find((m) => m.key === "claude-opus-4-6-thinking")!;
    // No account has opus quota data → fractions unknown, but #1 (ok) can still serve.
    expect(opus.withData).toBe(0);
    expect(opus.lowestRemaining).toBeNull();
    expect(opus.medianRemaining).toBeNull();
    expect(opus.bestRemaining).toBeNull();
    expect(opus.available).toBe(1);
  });

  it("flags near-exhausted accounts via lowCount", () => {
    const r = rollupProviderStats("antigravity", {
      ...antigravityStatus,
      quota: {
        accounts: [
          { id: 1, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.05 } },
          { id: 2, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.9 } },
        ],
      },
    });
    const gemini = r.models.find((m) => m.key === "gemini-2.5-pro")!;
    expect(gemini.available).toBe(2);
    expect(gemini.lowCount).toBe(1); // 0.05 < 0.2
    expect(gemini.lowestRemaining).toBeCloseTo(0.05, 5);
  });

  it("emits per-model account distribution by water band", () => {
    const r = rollupProviderStats("antigravity", {
      ...antigravityStatus,
      quota: { accounts: [
        { id: 1, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.03 } },
        { id: 2, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.15 } },
        { id: 3, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.40 } },
        { id: 4, enabled: true, quotaStatus: "ok", modelQuotaFractions: { "gemini-2.5-pro": 0.80 } },
        { id: 5, enabled: true, quotaStatus: "ok", modelQuotaFractions: {} },
      ] },
    });
    const g = r.models.find((m) => m.key === "gemini-2.5-pro")!;
    expect(g.distribution).toEqual({ exhausted: 1, warn: 1, low: 1, healthy: 1, noData: 1 });
  });
});

describe("RemoteStatsService.getStats", () => {
  const fake = (status: any) => ({ getStatus: () => status, getBoundCardsForAccount: () => [] }) as any;
  const svc = new RemoteStatsService(
    fake(antigravityStatus),
    fake({ ...antigravityStatus, mode: "remote-codex-server", models: [{ key: "gpt-5-codex", displayName: "GPT-5 Codex", bucket: "codex" }] }),
    fake({ ...antigravityStatus, mode: "remote-anthropic-server", models: [{ key: "claude-opus-4-6", displayName: "Claude Opus 4.6", bucket: "anthropic-claude" }] }),
    { accountQuotaSnapshot: { findMany: async () => [] } } as any,
    { getCardUsageSummary: async () => ({}), getHourlyFrequency: async () => ({}) } as any,
  );

  it("combines all three御三家 providers", () => {
    const out = svc.getStats();
    expect(out.ok).toBe(true);
    expect(out.providers.map((p) => p.id)).toEqual(["antigravity", "codex", "anthropic"]);
  });
});

describe("RemoteStatsService.getDashboard", () => {
  function build() {
    const statusWith = (mode: string, models: any[]) => ({
      mode,
      accounts: { total: 1, enabled: 1 },
      daily: { tokensUsed: 0 },
      models,
      quota: {
        accounts: [
          { id: 1, email: "a@x.com", planType: "pro", quotaStatus: "ok", activeLeases: 1, modelQuotaFractions: { "gpt-5": 0.5 } },
        ],
      },
    });
    const codex = {
      getStatus: () => statusWith("remote-codex-server", [{ key: "gpt-5", displayName: "GPT-5", bucket: "codex-gpt" }]),
      getBoundCardsForAccount: (accountId: number) =>
        accountId === 1
          ? [{ id: "card-1", name: "卡一", weight: 2, totalTokensUsed: 1234, totalRequests: 5, fairShare: { "codex-gpt": { fraction: 0.7, resetAt: 111 } } }]
          : [],
    };
    const empty = {
      getStatus: () => ({ mode: "m", accounts: { total: 0, enabled: 0 }, daily: { tokensUsed: 0 }, models: [], quota: { accounts: [] } }),
      getBoundCardsForAccount: () => [],
    };
    const prisma = {
      accountQuotaSnapshot: {
        findMany: async ({ where }: any) =>
          where.provider === "codex"
            ? [
                { accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60, hourlyResetAt: new Date("2026-06-07T15:00:00Z"), weeklyResetAt: null, timestamp: new Date("2026-06-07T10:00:00Z") },
                { accountId: 1, modelKey: "codex", hourlyPercent: 50, weeklyPercent: 55, hourlyResetAt: new Date("2026-06-07T15:00:00Z"), weeklyResetAt: null, timestamp: new Date("2026-06-07T11:00:00Z") },
              ]
            : [],
      },
    };
    const tokenUsageStats = {
      getCardUsageSummary: async ({ accessKeyId }: any) => ({
        totals: { totalTokens: 1234, requests: 5 },
        daily: [{ date: "2026-06-07", totalTokens: 1234, requests: 5 }],
        byModel: [],
      }),
      getHourlyFrequency: async ({ accessKeyId }: any) => ({
        days: 7,
        byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, requests: h === 18 ? 5 : 0, totalTokens: 0 })),
        totalRequests: 5,
      }),
    };
    return new RemoteStatsService(empty as any, codex as any, empty as any, prisma as any, tokenUsageStats as any);
  }

  it("aggregates health, account water levels/history, and bound-card detail per product", async () => {
    const out = await build().getDashboard({ days: 7 });
    expect(out.ok).toBe(true);
    expect(out.products.map((p) => p.id)).toEqual(["antigravity", "codex", "anthropic"]);

    const codex = out.products.find((p) => p.id === "codex")!;
    expect(codex.health.id).toBe("codex");
    expect(codex.accounts).toHaveLength(1);

    const acct = codex.accounts[0];
    expect(acct).toMatchObject({ id: 1, email: "a@x.com", planType: "pro", quotaStatus: "ok" });
    // Latest snapshot per modelKey = current water level.
    expect(acct.water).toEqual([
      { modelKey: "codex", hourlyPercent: 50, weeklyPercent: 55, hourlyResetAt: "2026-06-07T15:00:00.000Z", weeklyResetAt: null },
    ]);
    expect(acct.waterHistory).toHaveLength(2);

    expect(acct.boundCards).toHaveLength(1);
    const card = acct.boundCards[0];
    expect(card).toMatchObject({ id: "card-1", name: "卡一", weight: 2, totalTokensUsed: 1234, totalRequests: 5 });
    expect(card.fairShare).toEqual({ "codex-gpt": { fraction: 0.7, resetAt: 111 } });
    expect(card.usageTrend).toEqual([{ date: "2026-06-07", totalTokens: 1234, requests: 5 }]);
    expect(card.hourlyFrequency.find((b: any) => b.hour === 18).requests).toBe(5);
  });

  it("empty products carry an empty account list, not an error", async () => {
    const out = await build().getDashboard({ days: 7 });
    const antigravity = out.products.find((p) => p.id === "antigravity")!;
    expect(antigravity.accounts).toEqual([]);
  });
});
