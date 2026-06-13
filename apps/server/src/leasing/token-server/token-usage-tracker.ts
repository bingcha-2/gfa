/**
 * token-usage-tracker.ts — Non-blocking per-card token usage event tracker.
 *
 * Sits in the reportResult() hot path but does NO blocking I/O.
 * Events are buffered in memory and flushed to Prisma periodically.
 *
 * If flush fails, events are silently dropped — this is analytics data,
 * not critical business logic. The authoritative billing counters live in
 * access-keys.json (recordUsage); this table is the queryable per-call log.
 */

interface TokenUsageEvent {
  accessKeyId: string;
  customerId?: string;
  accessKeyName?: string;
  accountId?: number;
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
   * Flush all queued events to the database in a single batch.
   * Errors are caught and logged — never thrown.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    try {
      await this.prisma.cardTokenUsage.createMany({ data: batch });
    } catch (err) {
      // Silently drop — analytics data, not critical
      console.error("[token-usage-tracker] flush failed:", err);
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
