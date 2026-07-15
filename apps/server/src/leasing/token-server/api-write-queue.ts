/**
 * API 进程内共享 SQLite 写队列。
 *
 * SQLite 同时只能有一个写入者。RequestLog、TokenUsage 和额度快照即使由
 * 不同定时器触发，也必须通过同一条 FIFO 队列串行执行，避免彼此争锁。
 */
export class ApiWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.pendingCount--;
    });
  }

  getPendingCountForTesting(): number {
    return this.pendingCount;
  }
}
