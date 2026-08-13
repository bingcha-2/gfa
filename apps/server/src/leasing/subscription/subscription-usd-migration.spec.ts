import { describe, expect, it } from "vitest";

import { migrateBindSubscriptionToUsd } from "./subscription-usd-migration";

describe("migrateBindSubscriptionToUsd", () => {
  it("fills a legacy Codex Pro carpool subscription from built-in per-share defaults", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["codex"],
      levels: { codex: "pro" },
      shareSeats: 2,
      shareCapacity: 4,
    });

    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      quotaAlgorithm: "usd",
      quotaSeatCapacity: 6,
      usdQuotaByProduct: { codex: { fiveHour: 0, weekly: 200 } },
      usdQuotaMigrationVersion: 6,
    });
  });

  it("defaults a level-less legacy row to the CHEAPEST tier, not the top tier", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["anthropic"],
      shareSeats: 1,
      shareCapacity: 4,
    });
    // No recorded level and no catalog → anthropic 'pro' ($1.5 / $15.83 per seat),
    // NOT the top-tier max-20x ($30 / $158.33) the old fallback gifted.
    expect(result.config.usdQuotaByProduct).toEqual({ anthropic: { fiveHour: 1.5, weekly: 15.833333 } });
  });

  it("upgrades version-3 aggregate limits to product defaults once", () => {
    const input = {
      line: "bind",
      products: ["codex", "antigravity"],
      levels: { codex: "pro", antigravity: "ultra" },
      shareSeats: 1,
      shareCapacity: 4,
      usdLimit5h: 0,
      usdLimitWeekly: 123,
      usdQuotaMigrationVersion: 3,
      usdQuotaSource: "manual",
    };
    const result = migrateBindSubscriptionToUsd(input);

    expect(result.config.usdQuotaByProduct).toEqual({ codex: { fiveHour: 0, weekly: 100 } });
    expect(result.config.usdLimit5h).toBeUndefined();
    expect(result.config.usdLimitWeekly).toBeUndefined();
    expect(result.config.products).toEqual(["codex", "antigravity"]);
    expect(migrateBindSubscriptionToUsd(result.config).changed).toBe(false);
  });

  it("refreshes version-5 built-in Codex quotas to $100 per purchased share", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["codex"],
      levels: { codex: "pro" },
      shareSeats: 2,
      shareCapacity: 8,
      usdQuotaByProduct: { codex: { fiveHour: 0, weekly: 583.333334 } },
      usdQuotaSource: "catalog",
      usdQuotaMigrationVersion: 5,
    });

    expect(result.config).toMatchObject({
      usdQuotaByProduct: { codex: { fiveHour: 0, weekly: 200 } },
      usdQuotaMigrationVersion: 6,
    });
  });

  it("refreshes version-4 built-in estimates but preserves a valid manual override", () => {
    const priorDefault = {
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 1,
      usdQuotaByProduct: { anthropic: { fiveHour: 27.777778, weekly: 91.666667 } },
      usdQuotaSource: "catalog",
      usdQuotaMigrationVersion: 4,
    };
    const refreshed = migrateBindSubscriptionToUsd(priorDefault);
    expect(refreshed.config).toMatchObject({
      usdQuotaByProduct: { anthropic: { fiveHour: 30, weekly: 158.333333 } },
      usdQuotaMigrationVersion: 6,
    });

    const manual = migrateBindSubscriptionToUsd({
      ...priorDefault,
      usdQuotaByProduct: { anthropic: { fiveHour: 12, weekly: 34 } },
      usdQuotaSource: "manual",
    });
    expect(manual.config).toMatchObject({
      usdQuotaByProduct: { anthropic: { fiveHour: 12, weekly: 34 } },
      usdQuotaSource: "manual",
      usdQuotaMigrationVersion: 6,
    });
  });

  it("uses published per-share defaults and keeps supported products independent", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["codex", "anthropic"],
      levels: { codex: "pro", anthropic: "max-20x" },
      weight: 1,
      shareCapacity: 4,
    }, {
      pricing: {
        bind: {
          usdQuotaPerSeat: {
            codex: { pro: { fiveHour: 0, weekly: 400 } },
            anthropic: { "max-20x": { fiveHour: 50, weekly: 250 } },
          },
        },
      } as any,
    });

    expect(result.config.usdQuotaByProduct).toEqual({
      codex: { fiveHour: 0, weekly: 400 },
      anthropic: { fiveHour: 50, weekly: 250 },
    });
  });

  it("converts a legacy full-account catalog into a per-share quota once", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 1,
      shareCapacity: 8,
    }, {
      accountCapacity: 8,
      oversellFactor: 1.25,
      pricing: { bind: { usdQuota: { anthropic: { "max-20x": { fiveHour: 400, weekly: 1_000 } } } } },
    } as any);

    expect(result.config).toMatchObject({
      quotaSeatCapacity: 10,
      usdQuotaByProduct: { anthropic: { fiveHour: 40, weekly: 100 } },
    });
  });

  it("preserves a historical fixed denominator while removing the retired per-product map", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["codex"],
      levels: { codex: "pro" },
      shareSeats: 1,
      shareCapacity: 8,
      salesSeatCapacity: { codex: 10 },
    });

    expect(result.config.quotaSeatCapacity).toBe(10);
    expect(result.config.usdQuotaByProduct.codex.weekly).toBe(100);
    expect(result.config.salesSeatCapacity).toBeUndefined();
  });

  it("force-refreshes all existing subscriptions from a newly published per-share catalog", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["codex"],
      levels: { codex: "pro" },
      shareSeats: 2,
      shareCapacity: 8,
      usdLimit5h: 9,
      usdLimitWeekly: 99,
      usdQuotaMigrationVersion: 3,
      usdQuotaSource: "manual",
    }, {
      pricing: { bind: { usdQuotaPerSeat: { codex: { pro: { fiveHour: 5, weekly: 40 } } } } },
    } as any, { forceCatalogRefresh: true, catalogVersion: 7 });

    expect(result.config).toMatchObject({
      usdQuotaByProduct: { codex: { fiveHour: 10, weekly: 80 } },
      usdQuotaSource: "catalog",
      usdQuotaCatalogVersion: 7,
    });
  });

  it("repairs a partially applied catalog publish on the next startup", () => {
    const result = migrateBindSubscriptionToUsd({
      line: "bind",
      products: ["codex"],
      levels: { codex: "pro" },
      shareSeats: 1,
      shareCapacity: 8,
      usdLimit5h: 9,
      usdLimitWeekly: 99,
      usdQuotaMigrationVersion: 3,
      usdQuotaCatalogVersion: 6,
    }, {
      pricing: { bind: { usdQuotaPerSeat: { codex: { pro: { fiveHour: 5, weekly: 40 } } } } },
    } as any, { catalogVersion: 7 });

    expect(result.config).toMatchObject({
      usdQuotaByProduct: { codex: { fiveHour: 5, weekly: 40 } },
      usdQuotaCatalogVersion: 7,
    });
  });

  it("does not migrate pool subscriptions or Antigravity-only bind subscriptions", () => {
    expect(migrateBindSubscriptionToUsd({ line: "pool", products: ["codex"] }).changed).toBe(false);
    expect(migrateBindSubscriptionToUsd({ line: "pool", products: ["codex"], bindings: { codex: 7 } }).changed).toBe(false);
    expect(migrateBindSubscriptionToUsd({ line: "bind", products: ["antigravity"] }).changed).toBe(false);
  });

  it("migrates an early bound subscription even when its line discriminator is missing", () => {
    const result = migrateBindSubscriptionToUsd({
      products: ["codex"],
      levels: { codex: "pro" },
      bindings: { codex: 7 },
      shareSeats: 1,
    });

    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      line: "bind",
      quotaAlgorithm: "usd",
      usdQuotaByProduct: { codex: { fiveHour: 0, weekly: 100 } },
    });
  });
});
