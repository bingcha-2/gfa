/**
 * Redis-based distributed lock for AdsPower profiles.
 *
 * Prevents multiple workers from operating on the same browser profile
 * simultaneously. Uses SET NX PX for acquire and a Lua script for
 * atomic check-and-delete release.
 */

import Redis from "ioredis";
import { REDIS_KEYS } from "@gfa/shared";

const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

const EXTEND_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

export class ProfileLock {
  private redis: Redis;
  private defaultTtlMs: number;

  constructor(redis: Redis, defaultTtlMs = 5 * 60 * 1000) {
    this.redis = redis;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Attempt to acquire a lock for the given profile.
   * Returns true if the lock was acquired, false if already held.
   */
  async acquire(
    profileId: string,
    workerId: string,
    ttlMs?: number
  ): Promise<boolean> {
    const key = `${REDIS_KEYS.profileLock}${profileId}`;
    const result = await this.redis.set(
      key,
      workerId,
      "PX",
      ttlMs ?? this.defaultTtlMs,
      "NX"
    );
    return result === "OK";
  }

  /**
   * Release the lock only if still held by this worker.
   * Uses Lua script for atomic check-and-delete.
   */
  async release(profileId: string, workerId: string): Promise<boolean> {
    const key = `${REDIS_KEYS.profileLock}${profileId}`;
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, key, workerId);
    return result === 1;
  }

  /**
   * Extend the TTL of an existing lock (heartbeat).
   * Uses atomic Lua script — only extends if still owned by this worker.
   */
  async extend(
    profileId: string,
    workerId: string,
    ttlMs?: number
  ): Promise<boolean> {
    const key = `${REDIS_KEYS.profileLock}${profileId}`;
    const result = await this.redis.eval(
      EXTEND_SCRIPT,
      1,
      key,
      workerId,
      String(ttlMs ?? this.defaultTtlMs)
    );
    return result === 1;
  }
}
