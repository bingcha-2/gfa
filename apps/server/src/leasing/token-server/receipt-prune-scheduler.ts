import { msUntilNextBeijingHour } from "./beijing-daily-schedule";

const DEFAULT_RUN_AT_HOUR = 3;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_MAX_DURATION_MS = 5_000;
const DEFAULT_BATCH_PAUSE_MS = 25;

export interface ReceiptPruneTarget {
  provider: string;
  pruneBatch: (batchSize: number) => Promise<number>;
}

/**
 * Process-wide QuotaReportReceipt cleanup scheduler.
 *
 * FairShareTracker is instantiated once per provider. Giving every instance its
 * own timer makes all providers issue DELETEs at the same minute boundary, which
 * is especially harmful for SQLite's single-writer rollback-journal mode. This
 * scheduler owns one timer for the whole API process and runs bounded batches
 * serially, round-robin across providers.
 */
export class ReceiptPruneScheduler {
  private readonly targets = new Map<symbol, ReceiptPruneTarget>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cursor = 0;

  constructor(private readonly options: {
    runAtHour?: number;
    batchSize?: number;
    maxBatches?: number;
    maxDurationMs?: number;
    batchPauseMs?: number;
    now?: () => number;
    onError?: (provider: string, error: unknown) => void;
  } = {}) {}

  register(target: ReceiptPruneTarget): () => void {
    const id = Symbol(target.provider);
    this.targets.set(id, target);
    this.ensureTimer();

    return () => {
      this.targets.delete(id);
      if (this.targets.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        this.cursor = 0;
      }
    };
  }

  async runOnce(): Promise<void> {
    if (this.running || this.targets.size === 0) return;
    this.running = true;

    try {
      const entries = [...this.targets.entries()];
      const exhausted = new Set<symbol>();
      const batchSize = Math.max(1, Math.trunc(this.options.batchSize ?? DEFAULT_BATCH_SIZE));
      const maxBatches = Math.max(1, Math.trunc(this.options.maxBatches ?? DEFAULT_MAX_BATCHES));
      const maxDurationMs = Math.max(1, Math.trunc(this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS));
      const batchPauseMs = Math.max(0, Math.trunc(this.options.batchPauseMs ?? DEFAULT_BATCH_PAUSE_MS));
      const startedAt = this.now();
      let cursor = this.cursor % entries.length;

      for (let batch = 0; batch < maxBatches && exhausted.size < entries.length; batch++) {
        if (this.now() - startedAt >= maxDurationMs) break;
        let selected: [symbol, ReceiptPruneTarget] | null = null;
        for (let checked = 0; checked < entries.length; checked++) {
          const candidate = entries[cursor];
          cursor = (cursor + 1) % entries.length;
          if (!exhausted.has(candidate[0]) && this.targets.has(candidate[0])) {
            selected = candidate;
            break;
          }
        }
        if (!selected) break;

        const [id, target] = selected;
        try {
          const deleted = await target.pruneBatch(batchSize);
          if (deleted < batchSize) exhausted.add(id);
        } catch (error) {
          // Cleanup is low priority. Any database error (especially lock or
          // transaction timeout errors) ends the daily run instead of adding
          // more pressure to SQLite. It will be retried the next day.
          this.options.onError?.(target.provider, error);
          break;
        }

        if (batchPauseMs > 0 && batch + 1 < maxBatches && exhausted.size < entries.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, batchPauseMs));
        }
      }

      this.cursor = cursor;
    } finally {
      this.running = false;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    const runAtHour = Math.min(23, Math.max(0, Math.trunc(this.options.runAtHour ?? DEFAULT_RUN_AT_HOUR)));
    const delayMs = msUntilNextBeijingHour(this.now(), runAtHour);

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => {
        if (this.targets.size > 0) this.ensureTimer();
      });
    }, delayMs);
    (this.timer as any)?.unref?.();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

export const sharedReceiptPruneScheduler = new ReceiptPruneScheduler({
  onError: (provider, error) => {
    console.error(`[receipt-prune-scheduler] ${provider} prune failed:`, error);
  },
});
