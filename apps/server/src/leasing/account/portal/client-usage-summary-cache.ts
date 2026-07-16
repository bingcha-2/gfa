type CacheEntry = { expiresAt: number; value: any };
type InFlightEntry = { promise: Promise<any> };

/**
 * Process-local cache for the desktop usage summary.
 *
 * Writers call invalidate() only after CardUsageHourly is durable. Removing the
 * in-flight entry is intentional: an older query may still resolve for its
 * original caller, but the identity checks below prevent it from repopulating
 * the cache after a newer write or forced refresh.
 */
export class ClientUsageSummaryCache {
  private readonly values = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(private readonly maxEntries = 10_000) {}

  async getOrLoad(
    customerId: string,
    load: () => Promise<any>,
    fallback: any,
    options: { ttlMs: number; errorTtlMs: number; force?: boolean },
  ): Promise<any> {
    if (options.force) this.invalidate(customerId);

    const now = Date.now();
    const cached = this.values.get(customerId);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) this.values.delete(customerId);

    const existing = this.inFlight.get(customerId);
    if (existing) return existing.promise;

    let pending!: Promise<any>;
    pending = load()
      .then((value) => {
        if (this.inFlight.get(customerId)?.promise === pending) {
          this.set(customerId, value, options.ttlMs);
        }
        return value;
      })
      .catch(() => {
        if (this.inFlight.get(customerId)?.promise === pending) {
          this.set(customerId, fallback, options.errorTtlMs);
        }
        return fallback;
      })
      .finally(() => {
        if (this.inFlight.get(customerId)?.promise === pending) {
          this.inFlight.delete(customerId);
        }
      });
    this.inFlight.set(customerId, { promise: pending });
    return pending;
  }

  invalidate(customerId: string | null | undefined): void {
    if (!customerId) return;
    this.values.delete(customerId);
    this.inFlight.delete(customerId);
  }

  clear(): void {
    this.values.clear();
    this.inFlight.clear();
  }

  private set(customerId: string, value: any, ttlMs: number): void {
    if (!this.values.has(customerId) && this.values.size >= this.maxEntries) {
      const oldestKey = this.values.keys().next().value;
      if (oldestKey !== undefined) this.values.delete(oldestKey);
    }
    this.values.set(customerId, { expiresAt: Date.now() + ttlMs, value });
  }
}

export const sharedClientUsageSummaryCache = new ClientUsageSummaryCache();
