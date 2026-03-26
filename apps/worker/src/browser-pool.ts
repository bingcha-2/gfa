/**
 * BrowserPool — distributed Redis-backed pool of AdsPower browser profiles.
 *
 * Each task acquires a free profile from the pool, uses it, then releases it.
 * Profile IDs are configured via ADSPOWER_POOL_IDS env var (comma-separated).
 *
 * Lock key: gfa:pool:profile:{id}  → value: workerId, TTL: LOCK_TTL_MS
 *
 * If all profiles are busy, acquire() polls until one becomes free or times out.
 */

import type { Redis } from "ioredis";

const POOL_KEY_PREFIX = "gfa:pool:profile:";
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min — covers worst-case Google login + task execution
const POLL_INTERVAL_MS = 3_000;


export class BrowserPool {
  private profileIds: string[];
  private redis: Redis;

  constructor(redis: Redis) {
    const envIds = process.env.ADSPOWER_POOL_IDS ?? "";
    this.profileIds = envIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (this.profileIds.length === 0) {
      throw new Error(
        "[BrowserPool] ADSPOWER_POOL_IDS is not configured. " +
          "Set it to a comma-separated list of AdsPower profile IDs."
      );
    }

    this.redis = redis;
    console.log(
      `[BrowserPool] Initialized with ${this.profileIds.length} profiles: ${this.profileIds.join(", ")}`
    );
  }

  /** Number of profiles in the pool */
  get poolSize(): number {
    return this.profileIds.length;
  }

  /**
   * Acquire a free profile from the pool.
   * Blocks (polls) until a profile is available or timeoutMs is reached.
   * @throws Error if no profile becomes available within timeoutMs
   */
  async acquire(workerId: string, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const profileId of this.profileIds) {
        const key = `${POOL_KEY_PREFIX}${profileId}`;
        // SET NX PX: only set if key doesn't exist
        const result = await this.redis.set(key, workerId, "PX", LOCK_TTL_MS, "NX");

        if (result === "OK") {
          console.log(
            `[BrowserPool] Profile ${profileId} acquired by worker ${workerId}`
          );
          return profileId;
        }
      }

      // All profiles busy — wait before next poll
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      console.log(
        `[BrowserPool] All profiles busy, worker ${workerId} waiting... (${Math.round(remaining / 1000)}s left)`
      );
    }

    throw new Error(
      `[BrowserPool] No free profile available after ${timeoutMs}ms ` +
        `(pool size: ${this.profileIds.length}). ` +
        `Consider adding more profiles to ADSPOWER_POOL_IDS.`
    );
  }

  /**
   * Acquire a free profile from the pool, skipping any profile in the excluded set.
   * Used for retry loops where certain profiles are known to be broken.
   */
  async acquireExcluding(workerId: string, excluded: Set<string>, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const profileId of this.profileIds) {
        if (excluded.has(profileId)) continue; // skip known-bad profiles
        const key = `${POOL_KEY_PREFIX}${profileId}`;
        const result = await this.redis.set(key, workerId, "PX", LOCK_TTL_MS, "NX");

        if (result === "OK") {
          console.log(
            `[BrowserPool] Profile ${profileId} acquired by worker ${workerId} (excluding: ${[...excluded].join(", ") || "none"})`
          );
          return profileId;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }

    throw new Error(
      `[BrowserPool] No free profile available (excluding: ${[...excluded].join(", ")}) after ${timeoutMs}ms`
    );
  }


  async release(profileId: string, workerId: string): Promise<void> {
    const key = `${POOL_KEY_PREFIX}${profileId}`;

    // Only delete if we own the lock (Lua script for atomicity)
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const released = await this.redis.eval(luaScript, 1, key, workerId);

    if (released === 1) {
      console.log(
        `[BrowserPool] Profile ${profileId} released by worker ${workerId}`
      );
    } else {
      // Lock expired or stolen — non-fatal, just log
      console.warn(
        `[BrowserPool] Profile ${profileId} release by worker ${workerId} was a no-op ` +
          `(lock may have expired or been taken by another worker)`
      );
    }
  }

  /**
   * Force-release ALL profiles held by this workerId.
   * Called on stalled job detection or startup cleanup to prevent 20-min lock leak.
   */
  async releaseAllByWorker(workerId: string): Promise<void> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    let released = 0;
    for (const profileId of this.profileIds) {
      const key = `${POOL_KEY_PREFIX}${profileId}`;
      const result = await this.redis.eval(luaScript, 1, key, workerId);
      if (result === 1) released++;
    }

    if (released > 0) {
      console.log(`[BrowserPool] Force-released ${released} profile lock(s) held by ${workerId}`);
    }
  }

  /**
   * Check how many profiles are currently free.
   * Useful for health checks / status endpoints.
   */
  async freeCount(): Promise<number> {
    let free = 0;
    for (const profileId of this.profileIds) {
      const key = `${POOL_KEY_PREFIX}${profileId}`;
      const val = await this.redis.get(key);
      if (!val) free++;
    }
    return free;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
