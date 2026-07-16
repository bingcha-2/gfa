/**
 * API 进程内共享 SQLite 写队列。
 *
 * SQLite 同时只能有一个写入者。RequestLog、TokenUsage 和额度快照即使由
 * 不同定时器触发，也必须通过同一条 FIFO 队列串行执行，避免彼此争锁。
 */
export class ApiWriteQueue {
  private readonly normal: Array<QueueEntry<unknown>> = [];
  private readonly lowPriority: Array<QueueEntry<unknown>> = [];
  private running = false;
  private pendingCount = 0;

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.add(this.normal, task);
  }

  /**
   * Queue one cleanup batch. Normal API writes always run before the next
   * low-priority batch, so a multi-batch cleanup cannot monopolize SQLite.
   */
  enqueueLowPriority<T>(task: () => Promise<T>): Promise<T> {
    return this.add(this.lowPriority, task);
  }

  private add<T>(queue: Array<QueueEntry<unknown>>, task: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const result = new Promise<T>((resolve, reject) => {
      queue.push({
        task,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.drain();
    return result;
  }

  private drain(): void {
    if (this.running) return;
    const next = this.normal.shift() ?? this.lowPriority.shift();
    if (!next) return;
    this.running = true;
    void Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.pendingCount--;
        this.running = false;
        this.drain();
      });
  }

  getPendingCountForTesting(): number {
    return this.pendingCount;
  }
}

interface QueueEntry<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
