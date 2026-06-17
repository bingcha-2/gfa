import { describe, it, expect } from "vitest";

import { computePurchase } from "./pricing";

const CATALOG = {
  products: ["anthropic", "codex", "antigravity"],
  levels: {
    anthropic: ["pro", "max-5x", "max-20x"],
    codex: ["plus", "pro"],
    antigravity: ["pro", "ultra"],
  },
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50000 }, weeklyTokenLimit: 250000 },
    large: { bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000 },
  },
  pricing: {
    pool: {
      product: { anthropic: 6900, codex: 3900, antigravity: 3900 },
      usage: { small: 0, large: 3000 },
      devicePerExtra: 900,
    },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      share: { "1": 0, "2": -4000, "4": -7000, "8": -9000 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
};

describe("computePurchase pool line", () => {
  it("prices a single Claude pool purchase and snapshots usage config", () => {
    const result = computePurchase(CATALOG, {
      line: "pool",
      products: ["anthropic"],
      usageTier: "small",
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(6900);
    expect(result.config).toEqual({
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyTokenLimit: 250000,
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });
});

describe("computePurchase bind line", () => {
  it("uses shareSeats=8 as full-account seats without a shared-user discount", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 8,
      deviceLimit: 1,
    } as any);

    expect(result.priceCents).toBe(29900);
    expect(result.config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 8,
      shareCapacity: 8,
      weight: 8,
      assignmentPolicy: "preferred-dynamic",
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("uses shareSeats=2 as the bind seat count and equivalent 4-user price key", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 2,
      deviceLimit: 1,
    } as any);

    expect(result.priceCents).toBe(22900);
    expect(result.config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 2,
      shareCapacity: 8,
      weight: 2,
      assignmentPolicy: "preferred-dynamic",
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("converts legacy shareUsers=4 to shareSeats=2 and weight=2", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareUsers: 4,
      deviceLimit: 1,
    });

    expect(result.config).toMatchObject({
      shareSeats: 2,
      shareCapacity: 8,
      weight: 2,
      assignmentPolicy: "preferred-dynamic",
    });
  });

  it("keeps legacy shareUsers=8 compatible when shareCapacity=4", () => {
    const result = computePurchase({ ...CATALOG, shareCapacity: 4 }, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareUsers: 8,
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(20900);
    expect(result.config).toMatchObject({
      shareSeats: 1,
      shareCapacity: 4,
      weight: 1,
      assignmentPolicy: "preferred-dynamic",
    });
  });
});

describe("computePurchase validation", () => {
  it("throws for an unknown bind product level", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "nonexistent" }],
        shareUsers: 1,
        deviceLimit: 1,
      }),
    ).toThrow(/level|nonexistent/i);
  });

  it("throws for an unknown pool usage tier", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "pool",
        products: ["anthropic"],
        usageTier: "huge",
        deviceLimit: 1,
      }),
    ).toThrow(/usage|huge/i);
  });

  it("throws for invalid shareSeats=3", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "max-20x" }],
        shareSeats: 3,
        deviceLimit: 1,
      } as any),
    ).toThrow(/shareSeats|seat/i);
  });

  it("throws for fractional shareSeats", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "max-20x" }],
        shareSeats: 2.9,
        deviceLimit: 1,
      } as any),
    ).toThrow(/shareSeats|seat/i);
  });

  it("does not let legacy shareUsers mask an invalid explicit shareSeats", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "max-20x" }],
        shareSeats: 3,
        shareUsers: 4,
        deviceLimit: 1,
      } as any),
    ).toThrow(/shareSeats|seat/i);
  });

  it("throws when explicit shareSeats exceed shareCapacity", () => {
    expect(() =>
      computePurchase({ ...CATALOG, shareCapacity: 4 }, {
        line: "bind",
        items: [{ product: "anthropic", level: "max-20x" }],
        shareSeats: 8,
        deviceLimit: 1,
      } as any),
    ).toThrow(/shareSeats|seat/i);
  });
});
