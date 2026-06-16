/**
 * token-usage-tracker.ts — Non-blocking per-card token usage aggregator.
 *
 * Sits in the reportResult() hot path but does NO blocking I/O. Events are
 * buffered in memory and flushed periodically into the CardUsageHourly aggregate
 * (one row per hour×card×account×customer×model — row count is decoupled from
 * request count). There is no per-call raw table: analytics/cost/limits all read
 * the hourly aggregate or the persisted window snapshots.
 *
 * If flush fails, events are silently dropped — this is analytics data, not
 * critical business logic (authoritative limit windows live on the records).
 */

interface TokenUsageEvent {
  accessKeyId: string;
  customerId?: string;
  accessKeyName?: string;
  accountId?: number;
  accountEmail?: string;
  modelKey: string;
  bucket: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  rawTotalTokens: number;
  totalTokens: number;
  timestamp: Date;
}

const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

export class TokenUsageTracker {
  private queue: TokenUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: any) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /**
   * Record a usage event for a card. Pure in-memory push — never blocks.
   * The caller (reportResult) only invokes this once per deduped/exactly-once
   * report, so no further de-duplication is needed here.
   */
  record(event: {
    accessKeyId: string;
    customerId?: string;
    accessKeyName?: string;
    accountId?: number;
    accountEmail?: string;
    modelKey: string;
    bucket: string;
    status: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    rawTotalTokens?: number;
    totalTokens?: number;
  }): void {
    if (!event.accessKeyId) return;
    this.queue.push({
      accessKeyId: event.accessKeyId,
      customerId: event.customerId,
      accessKeyName: event.accessKeyName,
      accountId: event.accountId,
      accountEmail: event.accountEmail,
      modelKey: event.modelKey || "",
      bucket: event.bucket || "",
      status: Number(event.status || 0),
      inputTokens: Number(event.inputTokens || 0),
      outputTokens: Number(event.outputTokens || 0),
      cachedInputTokens: Number(event.cachedInputTokens || 0),
      rawTotalTokens: Number(event.rawTotalTokens || 0),
      totalTokens: Number(event.totalTokens || 0),
      timestamp: new Date(),
    });
  }

  /**
   * Flush all queued events into the CardUsageHourly aggregate. Row count tracks
   * cards×models×hours, NOT request count — a customer hammering the API doesn't
   * blow up the table. Errors are caught and logged — never thrown.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    await this.flushHourly(batch);
  }

  /** Floor a Date to the start of its UTC clock hour (Beijing is a whole-hour
   *  offset, so UTC-hour buckets align with Beijing hour/day boundaries too). */
  private static hourStart(ts: Date): Date {
    return new Date(Math.floor(ts.getTime() / 3_600_000) * 3_600_000);
  }

  /**
   * Merge a flush batch into per-(hour,card,account,customer,model,bucket) groups
   * and upsert-increment each into CardUsageHourly. Increment is safe because the
   * caller delivers each report exactly once (deduped upstream).
   */
  private async flushHourly(batch: TokenUsageEvent[]): Promise<void> {
    const groups = new Map<string, {
      hourStart: Date; accessKeyId: string; accountEmail: string; customerId: string;
      modelKey: string; bucket: string;
      requests: number; failedRequests: number; inputTokens: number; outputTokens: number;
      cachedInputTokens: number; rawTotalTokens: number; totalTokens: number;
    }>();
    for (const e of batch) {
      const hourStart = TokenUsageTracker.hourStart(e.timestamp);
      const accountEmail = e.accountEmail || "";
      const customerId = e.customerId || "";
      const modelKey = e.modelKey || "";
      const bucket = e.bucket || "";
      const key = `${hourStart.getTime()}|${e.accessKeyId}|${accountEmail}|${customerId}|${modelKey}|${bucket}`;
      let g = groups.get(key);
      if (!g) {
        g = { hourStart, accessKeyId: e.accessKeyId, accountEmail, customerId, modelKey, bucket,
          requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, rawTotalTokens: 0, totalTokens: 0 };
        groups.set(key, g);
      }
      g.requests += 1;
      // failed = non-2xx (mirrors portal isSuccessStatus): 0/unknown counts as failed.
      if (!(e.status >= 200 && e.status < 300)) g.failedRequests += 1;
      g.inputTokens += e.inputTokens;
      g.outputTokens += e.outputTokens;
      g.cachedInputTokens += e.cachedInputTokens;
      g.rawTotalTokens += e.rawTotalTokens;
      g.totalTokens += e.totalTokens;
    }

    for (const g of groups.values()) {
      const sums = {
        requests: g.requests, failedRequests: g.failedRequests, inputTokens: g.inputTokens, outputTokens: g.outputTokens,
        cachedInputTokens: g.cachedInputTokens, rawTotalTokens: g.rawTotalTokens, totalTokens: g.totalTokens,
      };
      try {
        await this.prisma.cardUsageHourly.upsert({
          where: {
            hourStart_accessKeyId_accountEmail_customerId_modelKey_bucket: {
              hourStart: g.hourStart, accessKeyId: g.accessKeyId, accountEmail: g.accountEmail,
              customerId: g.customerId, modelKey: g.modelKey, bucket: g.bucket,
            },
          },
          create: {
            hourStart: g.hourStart, accessKeyId: g.accessKeyId, accountEmail: g.accountEmail,
            customerId: g.customerId, modelKey: g.modelKey, bucket: g.bucket, ...sums,
          },
          update: {
            requests: { increment: sums.requests },
            failedRequests: { increment: sums.failedRequests },
            inputTokens: { increment: sums.inputTokens },
            outputTokens: { increment: sums.outputTokens },
            cachedInputTokens: { increment: sums.cachedInputTokens },
            rawTotalTokens: { increment: sums.rawTotalTokens },
            totalTokens: { increment: sums.totalTokens },
          },
        });
      } catch (err) {
        console.error("[token-usage-tracker] hourly upsert failed:", err);
      }
    }
  }

  /** Stop the periodic flush timer. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Expose queue for testing only. */
  getQueueForTesting(): readonly TokenUsageEvent[] {
    return this.queue;
  }
}
