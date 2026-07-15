/**
 * account-quota-snapshot-tracker.ts — 账号 5h/周额度水位时序写入器。
 *
 * 与 token-usage-tracker 同范式:reportResult 热路径只做内存 push,
 * 周期性批量 flush 到 Prisma(no-WAL 下避免每事件一锁)。额外做 **on-change 去重**:
 * 水位变化 < 0.1% 且 reset 时间未变就不入队(Antigravity 上游 20% 粒度 → 写入很稀疏)。
 *
 * 三家(antigravity/codex/anthropic)归一成统一字段(hourlyPercent/weeklyPercent/reset)。
 * 失败静默丢弃 —— 这是可观测历史,非关键计费。
 */

import { ApiWriteQueue } from "./api-write-queue";

const FLUSH_INTERVAL_MS = 10_000; // 10 秒
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const PRUNE_MAX_BATCHES = 20;
const CHANGE_THRESHOLD_PCT = 0.1; // 水位变化 ≥0.1% 才记一笔

export interface AccountQuotaSnapshotInput {
  provider: string;
  accountId: number;
  modelKey: string; // 账号 modelQuotaFractions 的 key,三家统一(始终有值)
  email?: string | null;
  hourlyPercent?: number | null;
  weeklyPercent?: number | null;
  hourlyResetAt?: Date | null;
  weeklyResetAt?: Date | null;
}

interface SnapshotRow {
  provider: string;
  accountId: number;
  modelKey: string;
  email: string | null;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: Date | null;
  weeklyResetAt: Date | null;
  timestamp: Date;
}

interface LastSeen {
  hourly: number | null;
  weekly: number | null;
  hReset: number;
  wReset: number;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pctChanged(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(a - b) + 1e-9 >= CHANGE_THRESHOLD_PCT;
}

export class AccountQuotaSnapshotTracker {
  private queue: SnapshotRow[] = [];
  private last = new Map<string, LastSeen>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly writeQueue: ApiWriteQueue;
  private flushPromise: Promise<void> | null = null;
  private prunePromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: any,
    opts: { now?: () => number; autoStart?: boolean; writeQueue?: ApiWriteQueue } = {},
  ) {
    this.now = opts.now || Date.now;
    this.writeQueue = opts.writeQueue ?? new ApiWriteQueue();
    if (opts.autoStart !== false) {
      this.flushTimer = setInterval(() => {
        if (!this.flushPromise) void this.flush();
      }, FLUSH_INTERVAL_MS);
      this.pruneTimer = setInterval(() => {
        if (!this.prunePromise) void this.pruneOld();
      }, PRUNE_INTERVAL_MS);
    }
  }

  /** 记录一笔水位快照(on-change 去重)。纯内存,不阻塞。 */
  record(input: AccountQuotaSnapshotInput): void {
    if (!input.provider || !input.accountId) return;
    const key = `${input.provider}:${input.accountId}:${input.modelKey || ""}`;
    const hourly = numOrNull(input.hourlyPercent);
    const weekly = numOrNull(input.weeklyPercent);
    const hReset = input.hourlyResetAt ? input.hourlyResetAt.getTime() : 0;
    const wReset = input.weeklyResetAt ? input.weeklyResetAt.getTime() : 0;

    const prev = this.last.get(key);
    if (prev && !this.changed(prev, hourly, weekly, hReset, wReset)) return;
    this.last.set(key, { hourly, weekly, hReset, wReset });

    this.queue.push({
      provider: input.provider,
      accountId: input.accountId,
      modelKey: input.modelKey,
      email: input.email ?? null,
      hourlyPercent: hourly,
      weeklyPercent: weekly,
      hourlyResetAt: input.hourlyResetAt ?? null,
      weeklyResetAt: input.weeklyResetAt ?? null,
      timestamp: new Date(),
    });
  }

  private changed(prev: LastSeen, hourly: number | null, weekly: number | null, hReset: number, wReset: number): boolean {
    if (pctChanged(prev.hourly, hourly)) return true;
    if (pctChanged(prev.weekly, weekly)) return true;
    if (prev.hReset !== hReset) return true;
    if (prev.wReset !== wReset) return true;
    return false;
  }

  /** 单批写库。错误捕获不抛 —— 分析数据。 */
  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const pending = this.writeQueue.enqueue(() => this.flushOnce()).finally(() => {
      this.flushPromise = null;
    });
    this.flushPromise = pending;
    return pending;
  }

  private async flushOnce(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    try {
      await this.prisma.accountQuotaSnapshot.createMany({ data: batch });
    } catch (err) {
      console.error("[account-quota-snapshot-tracker] flush failed:", err);
    }
  }

  async pruneOld(): Promise<void> {
    if (this.prunePromise) return this.prunePromise;
    const pending = this.writeQueue.enqueue(() => this.pruneOldOnce()).finally(() => {
      this.prunePromise = null;
    });
    this.prunePromise = pending;
    return pending;
  }

  private async pruneOldOnce(): Promise<void> {
    try {
      for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
        const rows = await this.prisma.accountQuotaSnapshot.findMany({
          where: { timestamp: { lt: new Date(this.now() - RETENTION_MS) } },
          orderBy: { timestamp: "asc" }, take: PRUNE_BATCH, select: { id: true },
        });
        if (rows.length === 0) break;
        await this.prisma.accountQuotaSnapshot.deleteMany({ where: { id: { in: rows.map((row: any) => row.id) } } });
        if (rows.length < PRUNE_BATCH) break;
      }
    } catch (err) {
      console.error("[account-quota-snapshot-tracker] prune failed:", err);
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  /** 仅测试用。 */
  getQueueForTesting(): readonly SnapshotRow[] {
    return this.queue;
  }
}
