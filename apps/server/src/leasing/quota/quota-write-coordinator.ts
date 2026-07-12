export interface PendingRevision<T> {
  key: string;
  revision: number;
  payload: T;
}

interface Waiter {
  revision: number;
  resolve: (revision: number) => void;
  reject: (error: unknown) => void;
}

interface PendingEntry<T> extends PendingRevision<T> {
  waiters: Waiter[];
}

function staleKeysFrom(error: unknown): Set<string> | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; staleKeys?: unknown };
  if (candidate.code !== "QUOTA_STALE_REVISION" || !Array.isArray(candidate.staleKeys)) return null;
  if (!candidate.staleKeys.every((key) => typeof key === "string")) return null;
  return new Set(candidate.staleKeys);
}

export class QuotaWriteCoordinator<T> {
  private readonly pending = new Map<string, PendingEntry<T>>();
  private readonly persisted = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(private readonly options: {
    commit: (batch: PendingRevision<T>[]) => Promise<void>;
    mergePayload?: (current: T, incoming: T) => T;
    maxDelayMs?: number;
    maxBatchSize?: number;
  }) {}

  enqueue(key: string, revision: number, payload: T, force = false): Promise<number> {
    const persisted = this.persisted.get(key) || 0;
    if (!force && persisted >= revision) return Promise.resolve(persisted);
    const promise = new Promise<number>((resolve, reject) => {
      const current = this.pending.get(key);
      const waiter = { revision, resolve, reject };
      if (current) {
        current.waiters.push(waiter);
        if (this.options.mergePayload) {
          current.payload = this.options.mergePayload(current.payload, payload);
        }
        if (revision >= current.revision) {
          current.revision = revision;
          if (!this.options.mergePayload) current.payload = payload;
        }
      } else {
        this.pending.set(key, { key, revision, payload, waiters: [waiter] });
      }
    });
    const maxBatchSize = this.options.maxBatchSize || 64;
    if (this.pending.size >= maxBatchSize) void this.flush();
    else this.ensureTimer();
    return promise;
  }

  scheduleLowPriority(work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.pending.size > 0 || this.flushing) {
          setTimeout(attempt, this.options.maxDelayMs || 10);
          return;
        }
        void work().then(resolve, reject);
      };
      setTimeout(attempt, 0);
    });
  }

  private ensureTimer(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.maxDelayMs || 10);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = true;
    const maxBatchSize = this.options.maxBatchSize || 64;
    const entries = [...this.pending.values()].slice(0, maxBatchSize);
    for (const entry of entries) this.pending.delete(entry.key);
    const batch = entries.map(({ key, revision, payload }) => ({ key, revision, payload }));
    try {
      await this.options.commit(batch);
      for (const entry of entries) {
        this.persisted.set(entry.key, Math.max(this.persisted.get(entry.key) || 0, entry.revision));
        for (const waiter of entry.waiters) waiter.resolve(entry.revision);
      }
    } catch (error) {
      const staleKeys = staleKeysFrom(error);
      const hasMatchingStaleKey = staleKeys != null && entries.some((entry) => staleKeys.has(entry.key));
      for (const entry of entries) {
        if (!hasMatchingStaleKey || staleKeys!.has(entry.key)) {
          for (const waiter of entry.waiters) waiter.reject(error);
          continue;
        }
        // The repository's stale error is a partial-success result: every key
        // not listed in staleKeys was committed before the error was raised.
        this.persisted.set(entry.key, Math.max(this.persisted.get(entry.key) || 0, entry.revision));
        for (const waiter of entry.waiters) waiter.resolve(entry.revision);
      }
    } finally {
      this.flushing = false;
      if (this.pending.size >= maxBatchSize) void this.flush();
      else if (this.pending.size > 0) this.ensureTimer();
    }
  }
}
