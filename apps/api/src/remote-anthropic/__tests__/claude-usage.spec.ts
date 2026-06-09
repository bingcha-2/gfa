import { afterEach, describe, expect, it, vi } from "vitest";

// claude-usage now egresses through proxyRequiredFetch (fail-closed). These tests
// drive the network via vi.stubGlobal("fetch"), so route the egress wrappers back
// to the (stubbed) global fetch — the proxy/fail-closed layer is covered in
// egress.spec.ts.
vi.mock("../../lease-core/egress", async (orig) => ({
  ...(await (orig as any)()),
  proxyRequiredFetch: (_p: unknown, url: string, init: any) => fetch(url, init),
  proxyAwareFetch: (_p: unknown, url: string, init: any) => fetch(url, init),
}));

import { fetchClaudeQuotaUpstream } from "../auth/claude-usage";

function mockUsage(status: number, json: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(typeof json === "string" ? json : JSON.stringify(json), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchClaudeQuotaUpstream (/api/oauth/usage)", () => {
  it("converts USED utilization (0–1 fraction) to REMAINING percent and keeps ISO resets", async () => {
    const reset5h = "2026-06-04T18:00:00.000Z";
    const reset7d = "2026-06-09T00:00:00.000Z";
    mockUsage(200, {
      five_hour: { utilization: 0.27, resets_at: reset5h },
      seven_day: { utilization: 0.6, resets_at: reset7d },
    });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.httpStatus).toBe(200);
    // remaining = (1 - used) * 100
    expect(snap.claudeQuota).toMatchObject({ hourlyPercent: 73, weeklyPercent: 40 });
    expect(snap.claudeQuota?.hourlyResetTime).toBe(reset5h);
    expect(snap.claudeQuota?.weeklyResetTime).toBe(reset7d);
  });

  it("also accepts utilization already expressed as 0–100", async () => {
    mockUsage(200, { five_hour: { utilization: 25, resets_at: null } });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.claudeQuota?.hourlyPercent).toBe(75);
  });

  it("falls back to the most restrictive weekly variant when seven_day is absent", async () => {
    mockUsage(200, {
      five_hour: { utilization: 0.1, resets_at: null },
      seven_day_opus: { utilization: 0.2, resets_at: null }, // 80% remaining
      seven_day_sonnet: { utilization: 0.7, resets_at: null }, // 30% remaining (more restrictive)
    });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.claudeQuota?.weeklyPercent).toBe(30);
  });

  it("returns raw payload but no quota when no windows are present", async () => {
    mockUsage(200, { extra_usage: { is_enabled: false } });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.claudeQuota).toBeUndefined();
    expect(snap.raw).toMatchObject({ extra_usage: { is_enabled: false } });
  });

  it("reads 套餐 from /api/oauth/profile (organization_type → plan)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/oauth/profile")) {
          return new Response(JSON.stringify({ organization: { organization_type: "claude_max" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ five_hour: { utilization: 0.1, resets_at: null } }), { status: 200 });
      }),
    );
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.planType).toBe("max");
    expect(snap.claudeQuota?.hourlyPercent).toBe(90);
  });

  it("surfaces an error on a non-ok response", async () => {
    mockUsage(401, "unauthorized");
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.httpStatus).toBe(401);
    expect(snap.error).toContain("401");
  });

  it("returns an error without calling fetch when no token is given", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const snap = await fetchClaudeQuotaUpstream("");
    expect(snap.error).toMatch(/access token/);
    expect(spy).not.toHaveBeenCalled();
  });
});
