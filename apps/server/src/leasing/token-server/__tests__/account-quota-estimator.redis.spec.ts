import * as crypto from "crypto";

import Redis from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountQuotaEstimator } from "../account-quota-estimator";

const redisUrl = process.env.QUOTA_ESTIMATOR_REDIS_TEST_URL || "";

describe.skipIf(!redisUrl)("AccountQuotaEstimator real Redis", () => {
  let accountKey: string;
  let stateKey: string;
  let tombstoneKey: string;
  let estimatorRedis: Redis;
  let adminRedis: Redis;
  let estimator: AccountQuotaEstimator;

  beforeEach(async () => {
    accountKey = crypto.randomUUID().replace(/-/g, "");
    stateKey = `gfa:quota-estimator:v1:{codex:${accountKey}}`;
    tombstoneKey = `gfa:quota-estimator-deleted:v1:{codex:${accountKey}}`;
    estimatorRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    adminRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await adminRedis.del(stateKey, tombstoneKey);
    estimator = new AccountQuotaEstimator(estimatorRedis, {
      autoStart: false,
      ttlSeconds: 120,
    });
  });

  afterEach(async () => {
    await adminRedis.del(stateKey, tombstoneKey);
    await estimator.destroy();
    await adminRedis.quit();
  });

  it("executes the reducer atomically across sampling, reset, TTL, and deletion", async () => {
    const observedAt = Date.parse("2030-01-01T00:00:00Z");
    const resetAt = observedAt + 5 * 60 * 60 * 1_000;
    const weeklyResetAt = observedAt + 7 * 24 * 60 * 60 * 1_000;
    const first = {
      observedAt,
      fiveHourRemainingBps: 10_000,
      fiveHourResetAt: resetAt,
      weeklyRemainingBps: 10_000,
      weeklyResetAt,
    };
    estimator.recordSnapshot({ provider: "codex", accountKey, accountId: 1, snapshot: first });
    await estimator.flush();
    estimator.recordReport({
      provider: "codex",
      accountKey,
      accountId: 1,
      apiValueUsd: 10,
      usageOccurredAt: observedAt + 1_000,
    });
    await estimator.flush();
    estimator.recordSnapshot({
      provider: "codex",
      accountKey,
      accountId: 1,
      snapshot: {
        ...first,
        observedAt: observedAt + 2_000,
        fiveHourRemainingBps: 9_000,
        weeklyRemainingBps: 9_000,
      },
    });
    await estimator.flush();

    let state = (await estimator.readMany([{ provider: "codex", accountKey }]))
      .get(`codex:${accountKey}`)!;
    expect(state.fiveHour).toMatchObject({
      epoch: 1,
      trackedUsedUsd: 10,
      inferredTotalUsd: 100,
      sampleCount: 1,
      confidence: "low",
    });
    expect(state.weekly?.inferredTotalUsd).toBe(100);

    const ttlBeforeRead = await adminRedis.pttl(stateKey);
    await estimator.readMany([{ provider: "codex", accountKey }]);
    const ttlAfterRead = await adminRedis.pttl(stateKey);
    expect(ttlBeforeRead).toBeGreaterThan(0);
    expect(ttlBeforeRead).toBeLessThanOrEqual(120_000);
    expect(ttlAfterRead).toBeLessThanOrEqual(ttlBeforeRead);

    estimator.recordReport({
      provider: "codex",
      accountKey,
      accountId: 1,
      apiValueUsd: 5,
      usageOccurredAt: observedAt + 2_500,
    });
    estimator.markReset({
      provider: "codex",
      accountKey,
      fiveHour: true,
      resetOccurredAt: observedAt + 2_600,
    });
    estimator.recordReport({
      provider: "codex",
      accountKey,
      accountId: 1,
      apiValueUsd: 2,
      usageOccurredAt: observedAt + 2_700,
    });
    estimator.recordSnapshot({
      provider: "codex",
      accountKey,
      accountId: 1,
      snapshot: {
        ...first,
        observedAt: observedAt + 3_000,
        fiveHourRemainingBps: 10_000,
        weeklyRemainingBps: 9_000,
      },
    });
    await estimator.flush();
    state = (await estimator.readMany([{ provider: "codex", accountKey }]))
      .get(`codex:${accountKey}`)!;
    expect(state.fiveHour).toMatchObject({
      epoch: 2,
      trackedUsedUsd: 2,
      inferredTotalUsd: null,
      sampleCount: 0,
      confidence: "insufficient",
    });
    expect(state.weekly).toMatchObject({
      epoch: 1,
      trackedUsedUsd: 17,
      inferredTotalUsd: 100,
    });

    await estimator.deleteAccount("codex", accountKey);
    estimator.recordSnapshot({ provider: "codex", accountKey, accountId: 1, snapshot: first });
    await estimator.flush();
    expect(await adminRedis.exists(stateKey)).toBe(0);
    expect(await adminRedis.exists(tombstoneKey)).toBe(1);
  });
});
