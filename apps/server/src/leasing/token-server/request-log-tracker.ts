/**
 * request-log-tracker.ts — per-request 热表写入器(codex / anthropic)。
 *
 * 全量逐请求落 RequestLog,但:
 *   - 写:缓冲 + 每 ~5s 批量 createMany(热路径不阻塞,对齐 TokenUsageTracker);
 *   - 清:每 ~1h 分小批删 48 小时之前的行(短保留控量)。
 *
 * 行数 = 请求量 × 2 天,靠 TTL 收敛;封号相关的永久副本另存 BanEventRequest。
 * headers 即使客户端已过滤也必须在服务端再次递归脱敏,绝不存 body/凭证。
 */

import { ApiWriteQueue } from "./api-write-queue";

const FLUSH_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1h
const HEADERS_MAX = 2_000;
const QUEUE_MAX = 10_000;
const FLUSH_BATCH = 1_000;
const PRUNE_BATCH = 500;
const PRUNE_MAX_BATCHES = 20;

export const REQUEST_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;

// 体积兜底:即便在保留期内,行数暴涨也封顶。超过就删最旧的多余部分(高量时实际保留 < 48h)。
// ~1KB/行 → 50 万行约 500MB,SQLite 仍健康。量级变了就改这个数。
export const REQUEST_LOG_MAX_ROWS = 500_000;

const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-access-key|x-token-server-secret|access[-_]?token|refresh[-_]?token|password|secret)$/i;

function safeHeaders(raw: unknown): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, child]) => [key, redact(child)]));
    };
    const encoded = JSON.stringify(redact(parsed));
    return encoded.length <= HEADERS_MAX ? encoded : JSON.stringify({ _truncated: true });
  } catch {
    // Invalid JSON cannot be safely inspected. Keep no attacker-controlled raw text.
    return "";
  }
}

export interface RequestLogEvent {
  provider: string;
  accountId?: number;
  accountEmail?: string;
  accessKeyId?: string;
  customerId?: string;
  deviceId?: string;
  userId?: string;
  sessionId?: string;
  modelKey?: string;
  status?: number;
  totalTokens?: number;
  reverseProxy?: boolean;
  surface?: string;
  sourceIp?: string;
  exitIp?: string;
  headers?: string;
  reportId?: string;
  traceId?: string;
  leaseId?: string;
  quotaSubjectId?: string;
  requestStartedAt?: number;
  upstreamCompletedAt?: number;
  snapshotObservedAt?: number;
  reason?: string;
  primaryReason?: string;
  weeklyReason?: string;
}

export class RequestLogTracker {
  private queue: any[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private overflowCount = 0;
  private flushPromise: Promise<void> | null = null;
  private prunePromise: Promise<void> | null = null;

  private readonly writeQueue: ApiWriteQueue;

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

  /** 每请求一次的内存 push(热路径,O(1))。 */
  record(e: RequestLogEvent): void {
    if (!e.provider) return;
    if (this.queue.length >= QUEUE_MAX) {
      this.queue.shift();
      this.overflowCount++;
    }
    this.queue.push({
      at: new Date(this.now()),
      provider: e.provider,
      accountId: Number(e.accountId || 0),
      accountEmail: e.accountEmail || "",
      accessKeyId: e.accessKeyId || "",
      customerId: e.customerId || "",
      deviceId: e.deviceId || "",
      userId: e.userId || "",
      sessionId: e.sessionId || "",
      modelKey: e.modelKey || "",
      status: Number(e.status || 0),
      totalTokens: Number(e.totalTokens || 0),
      reverseProxy: Boolean(e.reverseProxy),
      surface: e.surface || "",
      sourceIp: e.sourceIp || "",
      exitIp: e.exitIp || "",
      headers: safeHeaders(e.headers),
      reportId: e.reportId || "",
      traceId: e.traceId || "",
      leaseId: e.leaseId || "",
      quotaSubjectId: e.quotaSubjectId || "",
      requestStartedAt: BigInt(Math.max(0, Math.trunc(Number(e.requestStartedAt || 0)))),
      upstreamCompletedAt: BigInt(Math.max(0, Math.trunc(Number(e.upstreamCompletedAt || 0)))),
      snapshotObservedAt: BigInt(Math.max(0, Math.trunc(Number(e.snapshotObservedAt || 0)))),
      reason: String(e.reason || "").slice(0, 2_000),
      primaryReason: String(e.primaryReason || "").slice(0, 100),
      weeklyReason: String(e.weeklyReason || "").slice(0, 100),
    });
  }

  /** 批量落库。失败时有界放回队列供下次重试,绝不抛。 */
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
    const batch = this.queue.splice(0, FLUSH_BATCH);
    try {
      await this.prisma.requestLog.createMany({ data: batch });
    } catch (err) {
      const combined = [...batch, ...this.queue];
      const overflow = Math.max(0, combined.length - QUEUE_MAX);
      this.queue = overflow > 0 ? combined.slice(overflow) : combined;
      this.overflowCount += overflow;
      console.error("[request-log-tracker] flush failed:", err);
    }
  }

  /** 删保留期之前的行;再做体积兜底(超上限删最旧的多余部分)。绝不抛。 */
  async pruneOld(): Promise<void> {
    if (this.prunePromise) return this.prunePromise;
    const pending = this.writeQueue.enqueue(() => this.pruneOldOnce()).finally(() => {
      this.prunePromise = null;
    });
    this.prunePromise = pending;
    return pending;
  }

  private async pruneOldOnce(): Promise<void> {
    const cutoff = new Date(this.now() - REQUEST_LOG_RETENTION_MS);
    try {
      for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
        const old = await this.prisma.requestLog.findMany({
          where: { at: { lt: cutoff } }, orderBy: { at: "asc" }, take: PRUNE_BATCH, select: { id: true },
        });
        if (old.length === 0) break;
        await this.prisma.requestLog.deleteMany({ where: { id: { in: old.map((row: any) => row.id) } } });
        if (old.length < PRUNE_BATCH) break;
      }

      // 体积兜底也只做小批量 ID 删除，避免一次大范围 DELETE 长时间独占写锁。
      const count = await this.prisma.requestLog.count();
      if (count > REQUEST_LOG_MAX_ROWS) {
        let remaining = count - REQUEST_LOG_MAX_ROWS;
        let trimmed = 0;
        for (let batch = 0; batch < PRUNE_MAX_BATCHES && remaining > 0; batch++) {
          const oldest = await this.prisma.requestLog.findMany({
            orderBy: { at: "asc" }, take: Math.min(PRUNE_BATCH, remaining), select: { id: true },
          });
          if (oldest.length === 0) break;
          const res = await this.prisma.requestLog.deleteMany({
            where: { id: { in: oldest.map((row: any) => row.id) } },
          });
          const deleted = Number(res?.count ?? oldest.length);
          trimmed += deleted;
          remaining -= deleted;
          if (oldest.length < PRUNE_BATCH || deleted === 0) break;
        }
        console.warn(`[request-log-tracker] row cap hit (${count} > ${REQUEST_LOG_MAX_ROWS}); trimmed ${trimmed} oldest rows`);
      }
    } catch (err) {
      console.error("[request-log-tracker] prune failed:", err);
    }
  }

  destroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = null;
    this.pruneTimer = null;
  }

  getQueueForTesting(): readonly any[] {
    return this.queue;
  }

  getOverflowCountForTesting(): number { return this.overflowCount; }
}
