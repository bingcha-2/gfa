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
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 min — normal task takes 1-2 min; 5 min covers slow Google pages
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
  async acquire(workerId: string, timeoutMs = 180_000): Promise<string> {
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

      // All profiles busy — log who holds each lock for diagnosis
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      // Diagnostic: show which worker holds each profile and remaining TTL
      const lockInfo: string[] = [];
      for (const pid of this.profileIds) {
        const holder = await this.redis.get(`${POOL_KEY_PREFIX}${pid}`);
        const ttl = await this.redis.pttl(`${POOL_KEY_PREFIX}${pid}`);
        if (holder) {
          lockInfo.push(`${pid}→${holder}(${Math.round(ttl / 1000)}s)`);
        } else {
          lockInfo.push(`${pid}→FREE`);
        }
      }

      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      console.log(
        `[BrowserPool] All profiles busy, worker ${workerId} waiting... ` +
        `(${Math.round(remaining / 1000)}s left) locks: [${lockInfo.join(", ")}]`
      );
    }

    throw new Error(
      `[BrowserPool] No free profile available after ${timeoutMs}ms ` +
        `(pool size: ${this.profileIds.length}). ` +
        `Consider adding more profiles to ADSPOWER_POOL_IDS.`
    );
  }

  /**
   * Check which accountId last logged into a given profile.
   * Returns the accountId if found, or null if no record exists.
   * Used to decide whether existing browser session can be reused.
   */
  async getLastAccount(profileId: string): Promise<string | null> {
    return this.redis.get(`${POOL_KEY_PREFIX}${profileId}:lastAccount`);
  }

  /**
   * Record which accountId just logged into a given profile.
   * TTL = 24 hours (must outlive the profile lock so the next job can detect reuse).
   */
  async setLastAccount(profileId: string, accountId: string): Promise<void> {
    const LAST_ACCOUNT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    await this.redis.set(
      `${POOL_KEY_PREFIX}${profileId}:lastAccount`,
      accountId,
      "PX",
      LAST_ACCOUNT_TTL_MS
    );
  }

  /**
   * Record a login failure for an account. After this, subsequent jobs for
   * the same account will be rejected for the specified cooldown duration
   * (default: 10 minutes) to avoid repeated browser opens that escalate
   * Google risk detection.
   */
  async recordLoginFailure(accountId: string, cooldownMs = 10 * 60 * 1000): Promise<void> {
    await this.redis.set(
      `gfa:login-cooldown:${accountId}`,
      Date.now().toString(),
      "PX",
      cooldownMs
    );
  }

  /**
   * Check if an account is in login-failure cooldown.
   * Returns remaining seconds if cooling down, or 0 if safe to proceed.
   */
  async isLoginCoolingDown(accountId: string): Promise<number> {
    const ttl = await this.redis.pttl(`gfa:login-cooldown:${accountId}`);
    return ttl > 0 ? Math.ceil(ttl / 1000) : 0;
  }

  /**
   * Acquire a free profile from the pool, skipping any profile in the excluded set.
   * Used for retry loops where certain profiles are known to be broken.
   */
  async acquireExcluding(workerId: string, excluded: Set<string>, timeoutMs = 180_000): Promise<string> {
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
   * Record a task failure for an account (cumulative counter).
   * Used to track repeated failures across all task types.
   * After N failures (e.g. 3), the caller should mark the account as RISKY.
   *
   * Counter is permanent — must be manually cleared after human intervention
   * via clearAccountTaskFailures().
   *
   * @returns the new cumulative failure count
   */
  async recordAccountTaskFailure(accountId: string): Promise<number> {
    const key = `gfa:account-failures:${accountId}`;
    const count = await this.redis.incr(key);
    return count;
  }

  /**
   * Get the current cumulative task failure count for an account.
   */
  async getAccountTaskFailureCount(accountId: string): Promise<number> {
    const val = await this.redis.get(`gfa:account-failures:${accountId}`);
    return val ? parseInt(val, 10) : 0;
  }

  /**
   * Clear the task failure counter for an account (after human intervention).
   */
  async clearAccountTaskFailures(accountId: string): Promise<void> {
    await this.redis.del(`gfa:account-failures:${accountId}`);
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
