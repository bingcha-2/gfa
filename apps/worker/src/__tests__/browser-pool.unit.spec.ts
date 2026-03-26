/**
 * Unit tests for BrowserPool.
 *
 * Uses a mocked Redis instance (vi.fn) — no real Redis connection needed.
 * Tests acquire(), release(), freeCount(), and constructor error handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPool } from "../browser-pool";

// ----- Mock Redis factory -----
function buildMockRedis(overrides: {
  set?: ReturnType<typeof vi.fn>;
  eval?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    set: overrides.set ?? vi.fn().mockResolvedValue("OK"),
    eval: overrides.eval ?? vi.fn().mockResolvedValue(1),
    get: overrides.get ?? vi.fn().mockResolvedValue(null),
  } as any;
}

// Helper: construct pool with explicit ADSPOWER_POOL_IDS (avoids env pollution)
function buildPool(profileIds: string[], redis: any): BrowserPool {
  const oldEnv = process.env.ADSPOWER_POOL_IDS;
  process.env.ADSPOWER_POOL_IDS = profileIds.join(",");
  const pool = new BrowserPool(redis);
  process.env.ADSPOWER_POOL_IDS = oldEnv ?? "";
  return pool;
}

describe("BrowserPool.constructor", () => {
  it("throws when ADSPOWER_POOL_IDS is not set", () => {
    const old = process.env.ADSPOWER_POOL_IDS;
    process.env.ADSPOWER_POOL_IDS = "";
    expect(() => new BrowserPool({} as any)).toThrow(
      "ADSPOWER_POOL_IDS is not configured"
    );
    process.env.ADSPOWER_POOL_IDS = old ?? "";
  });

  it("initializes correctly with valid profile IDs", () => {
    const redis = buildMockRedis();
    const pool = buildPool(["p1", "p2"], redis);
    expect(pool.poolSize).toBe(2);
  });
});

describe("BrowserPool.acquire", () => {
  const WORKER_ID = "unit-worker-1";

  it("returns first profile immediately when it is free", async () => {
    const redisMock = buildMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
    });
    const pool = buildPool(["profile-a"], redisMock);

    const profileId = await pool.acquire(WORKER_ID);

    expect(profileId).toBe("profile-a");
    // SET NX was called with correct key and workerId
    expect(redisMock.set).toHaveBeenCalledWith(
      "gfa:pool:profile:profile-a",
      WORKER_ID,
      "PX",
      expect.any(Number),
      "NX"
    );
  });

  it("skips busy first profile and acquires second free profile", async () => {
    const redisMock = buildMockRedis({
      set: vi
        .fn()
        .mockResolvedValueOnce(null)  // profile-a is busy
        .mockResolvedValueOnce("OK"), // profile-b is free
    });
    const pool = buildPool(["profile-a", "profile-b"], redisMock);

    const profileId = await pool.acquire(WORKER_ID, 5_000);

    expect(profileId).toBe("profile-b");
    expect(redisMock.set).toHaveBeenCalledTimes(2);
  });

  it("throws immediately when all profiles are busy and timeout is 0", async () => {
    const redisMock = buildMockRedis({
      set: vi.fn().mockResolvedValue(null), // always busy
    });
    const pool = buildPool(["profile-x"], redisMock);

    await expect(pool.acquire(WORKER_ID, 0)).rejects.toThrow(
      "No free profile available"
    );
  });

  it("includes pool size in the timeout error message", async () => {
    const redisMock = buildMockRedis({
      set: vi.fn().mockResolvedValue(null),
    });
    const pool = buildPool(["p1", "p2"], redisMock);

    await expect(pool.acquire(WORKER_ID, 0)).rejects.toThrow("pool size: 2");
  });
});

describe("BrowserPool.release", () => {
  const WORKER_ID = "unit-worker-2";

  it("calls eval with Lua script, correct key and workerId", async () => {
    const redisMock = buildMockRedis({
      eval: vi.fn().mockResolvedValue(1),
    });
    const pool = buildPool(["profile-z"], redisMock);

    await pool.release("profile-z", WORKER_ID);

    expect(redisMock.eval).toHaveBeenCalledOnce();
    const [script, numKeys, key, worker] = redisMock.eval.mock.calls[0];
    expect(typeof script).toBe("string");
    expect(numKeys).toBe(1);
    expect(key).toBe("gfa:pool:profile:profile-z");
    expect(worker).toBe(WORKER_ID);
  });

  it("does not throw when Lua returns 0 (lock already expired)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const redisMock = buildMockRedis({
      eval: vi.fn().mockResolvedValue(0),
    });
    const pool = buildPool(["profile-z"], redisMock);

    await expect(pool.release("profile-z", WORKER_ID)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no-op")
    );
    warnSpy.mockRestore();
  });
});

describe("BrowserPool.freeCount", () => {
  it("returns total pool size when all profiles are free (redis.get returns null)", async () => {
    const redisMock = buildMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    const pool = buildPool(["p1", "p2", "p3"], redisMock);

    const count = await pool.freeCount();
    expect(count).toBe(3);
  });

  it("returns correct count when some profiles are occupied", async () => {
    const redisMock = buildMockRedis({
      get: vi
        .fn()
        .mockResolvedValueOnce("some-worker") // p1 is busy
        .mockResolvedValueOnce(null)           // p2 is free
        .mockResolvedValueOnce("other-worker") // p3 is busy
        ,
    });
    const pool = buildPool(["p1", "p2", "p3"], redisMock);

    const count = await pool.freeCount();
    expect(count).toBe(1);
  });

  it("returns 0 when all profiles are occupied", async () => {
    const redisMock = buildMockRedis({
      get: vi.fn().mockResolvedValue("occupied-worker"),
    });
    const pool = buildPool(["p1", "p2"], redisMock);

    const count = await pool.freeCount();
    expect(count).toBe(0);
  });
});
