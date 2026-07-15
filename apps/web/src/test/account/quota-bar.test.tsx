/**
 * Tests for quota bar threshold/format logic + rendering:
 *   src/components/account/quota-bar.tsx
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  quotaPercent,
  quotaRemainingPercent,
  quotaLevel,
  formatResetText,
  QuotaBar,
} from "@/components/account/quota-bar";
import type { SubscriptionQuota } from "@/lib/account/user-types";

describe("quotaPercent", () => {
  it("computes integer percent of used/limit", () => {
    expect(quotaPercent(0, 100)).toBe(0);
    expect(quotaPercent(50, 100)).toBe(50);
    expect(quotaPercent(85, 100)).toBe(85);
  });

  it("clamps to 100 when used exceeds limit", () => {
    expect(quotaPercent(150, 100)).toBe(100);
  });

  it("returns 0 for zero or negative limit (unlimited-ish)", () => {
    expect(quotaPercent(50, 0)).toBe(0);
    expect(quotaPercent(50, -1)).toBe(0);
  });
});

describe("quotaRemainingPercent", () => {
  it("rounds the remaining ratio directly, matching the desktop client", () => {
    expect(quotaRemainingPercent(60.4, 100)).toBe(40);
    expect(quotaRemainingPercent(85.4, 100)).toBe(15);
    expect(quotaRemainingPercent(105, 100)).toBe(0);
    expect(quotaRemainingPercent(50, 0)).toBe(100);
  });
});

describe("quotaLevel — remaining quota thresholds", () => {
  it("is green at 40-100% remaining", () => {
    expect(quotaLevel(0, 100)).toBe("ok");
    expect(quotaLevel(60, 100)).toBe("ok");
    expect(quotaLevel(60.4, 100)).toBe("ok");
  });

  it("is amber at 15-39% remaining", () => {
    expect(quotaLevel(61, 100)).toBe("warn");
    expect(quotaLevel(85, 100)).toBe("warn");
    expect(quotaLevel(85.4, 100)).toBe("warn");
  });

  it("is red below 15% remaining", () => {
    expect(quotaLevel(86, 100)).toBe("critical");
    expect(quotaLevel(85.6, 100)).toBe("critical");
    expect(quotaLevel(100, 100)).toBe("critical");
    expect(quotaLevel(150, 100)).toBe("critical");
  });
});

describe("formatResetText", () => {
  const templates = {
    hoursMinutes: "{h} 小时 {m} 分钟",
    minutesOnly: "{m} 分钟",
  };

  it("formats hours + minutes for >= 1h", () => {
    expect(formatResetText(3 * 3600_000 + 12 * 60_000, templates)).toBe(
      "3 小时 12 分钟"
    );
  });

  it("formats minutes only below 1h, rounding up partial minutes", () => {
    expect(formatResetText(5 * 60_000, templates)).toBe("5 分钟");
    expect(formatResetText(30_000, templates)).toBe("1 分钟");
  });

  it("returns null for null/zero/negative", () => {
    expect(formatResetText(null, templates)).toBeNull();
    expect(formatResetText(0, templates)).toBeNull();
    expect(formatResetText(-100, templates)).toBeNull();
  });
});

describe("QuotaBar rendering", () => {
  const baseQuota: SubscriptionQuota = {
    quotaMode: "static",
    buckets: [
      { bucket: "claude", used: 30, limit: 100 },
      { bucket: "codex", used: 90, limit: 100 },
    ],
    recentWindowTokens: 1200,
    tokenWindowResetMs: 90 * 60_000,
    weeklyTokenLimit: null,
    weeklyWindowResetMs: null,
    weeklyWindowTokens: 0,
    totalTokensUsed: 5000,
  };

  it("renders one bar per bucket with level data attributes", () => {
    render(<QuotaBar quota={baseQuota} />);

    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute("data-level", "ok");
    expect(bars[1]).toHaveAttribute("data-level", "critical");
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("adds a weekly bar driven by weeklyWindowTokens (not totalTokensUsed)", () => {
    render(
      <QuotaBar
        quota={{
          ...baseQuota,
          weeklyTokenLimit: 10_000,
          // 9000/10000 = 90% → critical. totalTokensUsed (5000 = 50% → ok)
          // must NOT be the source for this bar.
          weeklyWindowTokens: 9000,
          totalTokensUsed: 5000,
          weeklyWindowResetMs: 24 * 3600_000,
        }}
      />
    );

    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(3);
    expect(screen.getByText("本周额度")).toBeInTheDocument();
    // Weekly bar is the last one — level reflects weeklyWindowTokens (critical).
    expect(bars[2]).toHaveAttribute("data-level", "critical");
  });

  it("shows 不限量 instead of bars for unlimited mode", () => {
    render(
      <QuotaBar
        quota={{ ...baseQuota, quotaMode: "unlimited", buckets: [] }}
      />
    );

    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(screen.getByText("不限量")).toBeInTheDocument();
  });

  it("renders independent product 5h and weekly USD quota bars", () => {
    render(
      <QuotaBar
        quota={{
          ...baseQuota,
          quotaMode: "usd",
          buckets: [],
          usdQuotaByProduct: {
            codex: {
              fiveHour: { used: 8.5, limit: 10, resetMs: 60_000 },
              weekly: { used: 25, limit: 100, resetMs: 24 * 3600_000 },
            },
            anthropic: {
              fiveHour: { used: 1, limit: 20, resetMs: 60_000 },
              weekly: null,
            },
          },
        }}
      />
    );

    expect(screen.getByText("订阅额度")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getAllByText("5 小时额度")).toHaveLength(2);
    expect(screen.getByText("每周额度")).toBeInTheDocument();
    expect(screen.getByText("剩余 15%")).toBeInTheDocument();
    expect(screen.getByText("剩余 75%")).toBeInTheDocument();
    expect(screen.getByText("剩余 95%")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  });
});
