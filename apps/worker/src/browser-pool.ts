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
import type { AdsPowerClient } from "./adspower-client";

const POOL_KEY_PREFIX = "gfa:pool:profile:";
const ACCOUNT_LOCK_PREFIX = "gfa:account-lock:";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 min — normal task takes 1-2 min; 5 min covers slow Google pages
const POLL_INTERVAL_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 60_000; // extend lock every 60s
const MAX_HEARTBEAT_MS = 5 * 60 * 1000; // hard upper limit: stop heartbeat after 5 min


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
  async recordLoginFailure(accountId: string, cooldownMs = 2 * 60 * 1000): Promise<void> {
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

  /**
   * Acquire a free profile AND an account-level mutex for the given accountId.
   *
   * This is the primary entry point for all processors that operate on a
   * specific Google account. It ensures:
   *   1. Only one task can use a given accountId at any time (account lock)
   *   2. Profile affinity — prefers the profile that last logged into this
   *      account, reducing unnecessary re-login and Google risk signals
   *   3. If no profile is free, the account lock is released so other
   *      accounts can still proceed (no deadlock)
   *
   * @returns { profileId } — the assigned profile ID.
   */
  async acquireForAccount(
    workerId: string,
    accountId: string,
    timeoutMs = 180_000,
    excludedProfiles?: Set<string>
  ): Promise<{ profileId: string }> {
    const deadline = Date.now() + timeoutMs;
    const accountKey = `${ACCOUNT_LOCK_PREFIX}${accountId}`;

    while (Date.now() < deadline) {
      // Step 1: Acquire account-level lock
      const accountLock = await this.redis.set(
        accountKey, workerId, "PX", LOCK_TTL_MS, "NX"
      );

      if (accountLock !== "OK") {
        // Account is in use by another task — wait and retry
        const holder = await this.redis.get(accountKey);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        console.log(
          `[BrowserPool] Account ${accountId} locked by ${holder ?? "unknown"}, ` +
          `worker ${workerId} waiting... (${Math.round(remaining / 1000)}s left)`
        );
        await sleep(Math.min(POLL_INTERVAL_MS, remaining));
        continue;
      }

      // Step 2: Account locked — now find a profile.
      // Priority: profile with lastAccount === accountId (reduces profile switching)
      let profileId: string | null = null;

      // 2a: Try affinity profile first
      for (const pid of this.profileIds) {
        if (excludedProfiles?.has(pid)) continue;
        const lastAcc = await this.redis.get(`${POOL_KEY_PREFIX}${pid}:lastAccount`);
        if (lastAcc === accountId) {
          const result = await this.redis.set(
            `${POOL_KEY_PREFIX}${pid}`, workerId, "PX", LOCK_TTL_MS, "NX"
          );
          if (result === "OK") {
            profileId = pid;
            break;
          }
          // Affinity profile is busy — fall through to any free profile
        }
      }

      // 2b: No affinity match — try any free profile
      if (!profileId) {
        for (const pid of this.profileIds) {
          if (excludedProfiles?.has(pid)) continue;
          const result = await this.redis.set(
            `${POOL_KEY_PREFIX}${pid}`, workerId, "PX", LOCK_TTL_MS, "NX"
          );
          if (result === "OK") {
            profileId = pid;
            break;
          }
        }
      }

      // 2c: No free profile — release account lock and wait
      if (!profileId) {
        await this.redis.del(accountKey);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        // Diagnostic: show lock status
        const lockInfo: string[] = [];
        for (const pid of this.profileIds) {
          const holder = await this.redis.get(`${POOL_KEY_PREFIX}${pid}`);
          const ttl = await this.redis.pttl(`${POOL_KEY_PREFIX}${pid}`);
          lockInfo.push(holder
            ? `${pid}→${holder}(${Math.round(ttl / 1000)}s)`
            : `${pid}→FREE`
          );
        }
        console.log(
          `[BrowserPool] Account ${accountId} locked OK but no free profile, released account lock. ` +
          `Worker ${workerId} waiting... (${Math.round(remaining / 1000)}s left) ` +
          `locks: [${lockInfo.join(", ")}]`
        );
        await sleep(Math.min(POLL_INTERVAL_MS, remaining));
        continue;
      }

      // Success: both account lock and profile lock acquired
      console.log(
        `[BrowserPool] Profile ${profileId} acquired for account ${accountId} ` +
        `by worker ${workerId}`
      );
      return { profileId };
    }

    throw new Error(
      `[BrowserPool] No profile+account available for account ${accountId} ` +
      `after ${timeoutMs}ms (pool size: ${this.profileIds.length}). ` +
      `Consider adding more profiles to ADSPOWER_POOL_IDS.`
    );
  }

  /**
   * Acquire a profile for the given account AND open it via AdsPower.
   * If openProfile fails, the bad profile is released and another profile
   * is tried — prevents a single broken profile from blocking all tasks.
   *
   * Callers get back the same shape as acquireForAccount plus the debugUrl.
   * The account lock is kept throughout; only the profile lock rotates on failure.
   */
  async acquireAndOpen(
    workerId: string,
    accountId: string,
    adspower: AdsPowerClient,
    opts?: { maxProfileRetries?: number; timeoutMs?: number }
  ): Promise<{ profileId: string; debugUrl: string }> {
    const maxRetries = opts?.maxProfileRetries ?? this.profileIds.length;
    const timeoutMs = opts?.timeoutMs ?? 180_000;
    const failedProfiles = new Set<string>();
    const canForceClose = this.createForceCloseGuard(workerId);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { profileId } = await this.acquireForAccount(workerId, accountId, timeoutMs, failedProfiles);

      try {
        const { debugUrl } = await adspower.openProfile(profileId, canForceClose);
        return { profileId, debugUrl };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[BrowserPool] openProfile(${profileId}) failed: ${msg}. ` +
          `Releasing and trying another profile (attempt ${attempt + 1}/${maxRetries}).`
        );
        failedProfiles.add(profileId);
        // Release the broken profile lock so it doesn't block the pool
        await adspower.closeProfile(profileId).catch(() => {});
        await this.release(profileId, workerId).catch(() => {});
        // Account lock stays held — we'll acquire a different profile next iteration.
        // But acquireForAccount also acquires the account lock, so release it first
        // to avoid self-deadlock on re-entry.
        await this.releaseAccount(accountId, workerId).catch(() => {});
      }
    }

    throw new Error(
      `[BrowserPool] All ${failedProfiles.size} tried profiles failed to open for account ${accountId}. ` +
      `Failed profiles: [${[...failedProfiles].join(", ")}]`
    );
  }

  /**
   * Release the account-level lock.
   * Must be called in the processor's finally block alongside release(profileId).
   */
  async releaseAccount(accountId: string, workerId: string): Promise<void> {
    const key = `${ACCOUNT_LOCK_PREFIX}${accountId}`;
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const released = await this.redis.eval(luaScript, 1, key, workerId);
    if (released === 1) {
      console.log(`[BrowserPool] Account lock ${accountId} released by worker ${workerId}`);
    }
  }

  /**
   * Force-release ALL account locks held by this workerId.
   * Called on stalled job detection or startup cleanup.
   * Uses SCAN to find all account lock keys (no fixed list like profiles).
   */
  async releaseAllAccountsByWorker(workerId: string): Promise<void> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    let cursor = "0";
    let released = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, "MATCH", `${ACCOUNT_LOCK_PREFIX}*`, "COUNT", 100
      );
      cursor = nextCursor;
      for (const key of keys) {
        const result = await this.redis.eval(luaScript, 1, key, workerId);
        if (result === 1) released++;
      }
    } while (cursor !== "0");

    if (released > 0) {
      console.log(`[BrowserPool] Force-released ${released} account lock(s) held by ${workerId}`);
    }
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
   * Clear the login cooldown for an account completely.
   */
  async clearLoginCooldown(accountId: string): Promise<void> {
    await this.redis.del(`gfa:login-cooldown:${accountId}`);
  }

  /**
   * Record an invite cooldown for an account.
   * Called when Google rejects an invite due to rate limiting
   * ("Your invitation wasn't sent" / card count unchanged after send).
   * Default TTL: 24 hours.
   */
  async recordInviteCooldown(accountId: string, cooldownMs = 24 * 60 * 60 * 1000): Promise<void> {
    await this.redis.set(
      `gfa:invite-cooldown:${accountId}`,
      Date.now().toString(),
      "PX",
      cooldownMs
    );
  }

  /**
   * Check if an account is in invite cooldown (Google rate limit).
   * Returns remaining seconds if cooling down, or 0 if safe to invite.
   */
  async isInviteCoolingDown(accountId: string): Promise<number> {
    const ttl = await this.redis.pttl(`gfa:invite-cooldown:${accountId}`);
    return ttl > 0 ? Math.ceil(ttl / 1000) : 0;
  }

  /**
   * Clear the invite cooldown for an account completely.
   */
  async clearInviteCooldown(accountId: string): Promise<void> {
    await this.redis.del(`gfa:invite-cooldown:${accountId}`);
  }

  /**
   * Start a heartbeat that periodically extends the Redis lock TTL for both
   * the profile and account locks.  Prevents lock expiration while a task is
   * still actively using the browser.
   *
   * Automatically stops after MAX_HEARTBEAT_MS (hard ceiling) to prevent
   * hung tasks from holding a profile forever.
   *
   * @returns A stop function — call it in the processor's `finally` block.
   */
  startHeartbeat(
    profileId: string,
    accountId: string,
    workerId: string
  ): () => void {
    const startTime = Date.now();
    const luaExtend = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("pexpire", KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
    `;

    const interval = setInterval(async () => {
      // Hard ceiling: auto-stop after MAX_HEARTBEAT_MS
      if (Date.now() - startTime > MAX_HEARTBEAT_MS) {
        clearInterval(interval);
        console.warn(
          `[BrowserPool] Heartbeat for profile ${profileId} exceeded max lifetime ` +
          `(${MAX_HEARTBEAT_MS / 1000}s) — stopping. Lock will expire naturally.`
        );
        return;
      }

      try {
        await this.redis.eval(
          luaExtend, 1,
          `${POOL_KEY_PREFIX}${profileId}`, workerId, String(LOCK_TTL_MS)
        );
        await this.redis.eval(
          luaExtend, 1,
          `${ACCOUNT_LOCK_PREFIX}${accountId}`, workerId, String(LOCK_TTL_MS)
        );
      } catch (err) {
        // Non-fatal: if Redis is temporarily unreachable the lock may expire,
        // but the next heartbeat tick will re-extend if Redis recovers.
        console.warn(
          `[BrowserPool] Heartbeat failed for profile ${profileId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(interval);
  }

  /**
   * Create a guard function that checks whether it is safe to force-close
   * an active AdsPower profile.  Passed to `AdsPowerClient.openProfile()`
   * so it won't kill a browser that another task is still using.
   *
   * Force-close is allowed when:
   *   - No Redis lock exists for the profile (stale / abandoned browser)
   *   - The lock is held by the same workerId (our own leftover)
   *
   * Force-close is BLOCKED when:
   *   - The lock is held by a different workerId
   */
  createForceCloseGuard(
    _workerId: string
  ): (profileId: string) => Promise<boolean> {
    return async (profileId: string) => {
      const key = `${POOL_KEY_PREFIX}${profileId}`;
      const holder = await this.redis.get(key);
      // Only allow force-close if NO lock exists (truly stale/abandoned browser).
      // If any lock exists — even from the same workerId — another task may be
      // actively using this profile. In a single-worker setup all tasks share
      // the same workerId, so checking `holder === workerId` is not sufficient.
      return !holder;
    };
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
