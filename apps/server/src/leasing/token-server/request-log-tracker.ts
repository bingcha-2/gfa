/**
 * request-log-tracker.ts — per-request 热表写入器(codex / anthropic)。
 *
 * 全量逐请求落 RequestLog,但:
 *   - 写:缓冲 + 每 ~5s 批量 createMany(热路径不阻塞,对齐 TokenUsageTracker);
 *   - 清:每 ~1h 分小批删 72 小时之前的行(短保留控量)。
 *
 * 行数 = 请求量 × 3 天,靠 TTL 收敛;封号相关的永久副本另存 BanEventRequest。
 * headers 即使客户端已过滤也必须在服务端再次递归脱敏,绝不存 body/凭证。
 */

const FLUSH_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1h
const HEADERS_MAX = 2_000;
const QUEUE_MAX = 10_000;
const PRUNE_BATCH = 500;

export const REQUEST_LOG_RETENTION_MS = 72 * 60 * 60 * 1000;

// 体积兜底:即便在保留期内,行数暴涨也封顶。超过就删最旧的多余部分(高量时实际保留 < 72h)。
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

  constructor(private readonly prisma: any, opts: { now?: () => number; autoStart?: boolean } = {}) {
    this.now = opts.now || Date.now;
    if (opts.autoStart !== false) {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.pruneTimer = setInterval(() => this.pruneOld(), PRUNE_INTERVAL_MS);
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
      reason: String(e.reason || "").slice(0, 200),
      primaryReason: String(e.primaryReason || "").slice(0, 100),
      weeklyReason: String(e.weeklyReason || "").slice(0, 100),
    });
  }

  /** 批量落库。失败丢弃(分析数据,非关键),绝不抛。 */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    try {
      await this.prisma.requestLog.createMany({ data: batch });
    } catch (err) {
      console.error("[request-log-tracker] flush failed:", err);
    }
  }

  /** 删保留期之前的行;再做体积兜底(超上限删最旧的多余部分)。绝不抛。 */
  async pruneOld(): Promise<void> {
    const cutoff = new Date(this.now() - REQUEST_LOG_RETENTION_MS);
    try {
      for (let batch = 0; batch < 20; batch++) {
        const old = await this.prisma.requestLog.findMany({
          where: { at: { lt: cutoff } }, orderBy: { at: "asc" }, take: PRUNE_BATCH, select: { id: true },
        });
        if (old.length === 0) break;
        await this.prisma.requestLog.deleteMany({ where: { id: { in: old.map((row: any) => row.id) } } });
        if (old.length < PRUNE_BATCH) break;
      }

      // 体积兜底:行数超上限 → 找到第 MAX 新行的 at 作阈值,删更旧的(高量时压实到上限内)。
      const count = await this.prisma.requestLog.count();
      if (count > REQUEST_LOG_MAX_ROWS) {
        const boundary = await this.prisma.requestLog.findMany({
          orderBy: { at: "desc" }, skip: REQUEST_LOG_MAX_ROWS, take: 1, select: { at: true },
        });
        if (boundary[0]) {
          const res = await this.prisma.requestLog.deleteMany({ where: { at: { lt: boundary[0].at } } });
          console.warn(`[request-log-tracker] row cap hit (${count} > ${REQUEST_LOG_MAX_ROWS}); trimmed ${res?.count ?? "?"} oldest rows`);
        }
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
