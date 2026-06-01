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
});

describe("RemoteStatsService", () => {
  it("combines both providers", () => {
    const fake = (status: any) => ({ getStatus: () => status }) as any;
    const svc = new RemoteStatsService(
      fake(antigravityStatus),
      fake({ ...antigravityStatus, mode: "remote-codex-server", models: [{ key: "gpt-5-codex", displayName: "GPT-5 Codex", bucket: "codex" }] }),
    );
    const out = svc.getStats();
    expect(out.ok).toBe(true);
    expect(out.providers.map((p) => p.id)).toEqual(["antigravity", "codex"]);
  });
});
