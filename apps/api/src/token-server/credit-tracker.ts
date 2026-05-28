/**
 * credit-tracker.ts — Non-blocking credit consumption event tracker.
 *
 * Sits in the reportResult() hot path but does NO blocking I/O.
 * Events are buffered in memory and flushed to Prisma periodically.
 *
 * If flush fails, events are silently dropped — this is analytics data,
 * not critical business logic.
 */

interface CreditEvent {
  accountId: number;
  email: string;
  oldAmount: number;
  newAmount: number;
  consumed: number;
  accessKeyId?: string;
  accessKeyName?: string;
  timestamp: Date;
}

const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

export class CreditTracker {
  private queue: CreditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: any) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /**
   * Record a credit change. Only queues an event when credits DECREASE.
   * Pure in-memory push — never blocks.
   */
  record(
    accountId: number,
    email: string,
    oldAmount: number,
    newAmount: number,
    accessKeyId?: string,
    accessKeyName?: string,
  ): void {
    if (oldAmount <= 0 || newAmount >= oldAmount) return;
    this.queue.push({
      accountId,
      email,
      oldAmount,
      newAmount,
      consumed: oldAmount - newAmount,
      accessKeyId,
      accessKeyName,
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
      await this.prisma.creditConsumption.createMany({ data: batch });
    } catch (err) {
      // Silently drop — analytics data, not critical
      console.error("[credit-tracker] flush failed:", err);
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
  getQueueForTesting(): readonly CreditEvent[] {
    return this.queue;
  }
}
