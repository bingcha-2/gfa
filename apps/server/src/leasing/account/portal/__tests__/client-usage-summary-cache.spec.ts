import { describe, expect, it, vi } from "vitest";

import { ClientUsageSummaryCache } from "../client-usage-summary-cache";

describe("ClientUsageSummaryCache", () => {
  it("does not let a stale in-flight query repopulate after invalidation", async () => {
    const cache = new ClientUsageSummaryCache();
    let resolveOld!: (value: string) => void;
    const oldLoad = vi.fn(() => new Promise<string>((resolve) => { resolveOld = resolve; }));
    const options = { ttlMs: 300_000, errorTtlMs: 30_000 };

    const oldResult = cache.getOrLoad("cust-1", oldLoad, "fallback", options);
    cache.invalidate("cust-1");
    const freshResult = await cache.getOrLoad("cust-1", async () => "fresh", "fallback", options);
    resolveOld("old");

    expect(await oldResult).toBe("old");
    expect(freshResult).toBe("fresh");
    expect(await cache.getOrLoad("cust-1", async () => "wrong", "fallback", options)).toBe("fresh");
  });
});
