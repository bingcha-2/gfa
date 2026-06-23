/**
 * ban-event-tracker.ts — 封号定因的事件记录器(codex / anthropic)。
 *
 * 两层数据,都有界:
 *   1. 内存环形缓冲:每个母号(provider+accountId)维护"最近 N 条"请求的元数据
 *      (健康号【永不落库】,只在内存滚动、溢出淘汰最旧)。
 *   2. 封号时 dump:某号触发永久封禁时,把它当时的环一次性写进 AccountBanEvent
 *      + 子表 BanEventRequest(封号前请求时间线),然后清空该环。
 *
 * 落库行数 = 封号次数(罕见)+ 封号次数 × N,绝不随请求量线性增长。observeRequest 是
 * 热路径里每请求一次的纯内存 push;recordBan 是 fire-and-forget,prisma 失败也绝不抛。
 */

const DEFAULT_RING_SIZE = 200;
const BODY_MAX = 1000;

interface RingItem {
  at: Date;
  accessKeyId: string;
  customerId: string;
  modelKey: string;
  status: number;
  totalTokens: number;
  reverseProxy: boolean;
  surface: string;
  sourceIp: string;
  exitIp: string;
}

export interface ObserveRequestInput {
  provider: string;
  accountId: number;
  accessKeyId?: string;
  customerId?: string;
  modelKey?: string;
  status?: number;
  totalTokens?: number;
  reverseProxy?: boolean;
  surface?: string;
  sourceIp?: string;
  exitIp?: string;
}

export interface RecordBanInput {
  provider: string;
  accountId: number;
  accountEmail?: string;
  reason?: string;
  upstreamStatus?: number;
  upstreamBody?: string;
  modelKey?: string;
  deathStrikes?: number;
}

export class BanEventTracker {
  private readonly rings = new Map<string, RingItem[]>();
  private readonly ringSize: number;
  private readonly now: () => number;

  constructor(private readonly prisma: any, opts: { ringSize?: number; now?: () => number } = {}) {
    this.ringSize = Math.max(1, opts.ringSize || DEFAULT_RING_SIZE);
    this.now = opts.now || Date.now;
  }

  private key(provider: string, accountId: number): string {
    return `${provider}:${accountId}`;
  }

  /** 每请求一次的内存 push(热路径,O(1))。健康号永不落库。 */
  observeRequest(e: ObserveRequestInput): void {
    if (!e.provider || !e.accountId) return;
    const k = this.key(e.provider, e.accountId);
    let ring = this.rings.get(k);
    if (!ring) {
      ring = [];
      this.rings.set(k, ring);
    }
    ring.push({
      at: new Date(this.now()),
      accessKeyId: e.accessKeyId || "",
      customerId: e.customerId || "",
      modelKey: e.modelKey || "",
      status: Number(e.status || 0),
      totalTokens: Number(e.totalTokens || 0),
      reverseProxy: Boolean(e.reverseProxy),
      surface: e.surface || "",
      sourceIp: e.sourceIp || "",
      exitIp: e.exitIp || "",
    });
    if (ring.length > this.ringSize) ring.splice(0, ring.length - this.ringSize);
  }

  /** 封号时落库:建事件 + dump 环(请求时间线),清空该环。fire-and-forget,绝不抛。 */
  async recordBan(e: RecordBanInput): Promise<void> {
    const k = this.key(e.provider, e.accountId);
    const snapshot = this.rings.get(k) || [];
    this.rings.delete(k); // 落库即清空,避免下一次封号重复 dump
    try {
      await this.prisma.accountBanEvent.create({
        data: {
          provider: e.provider,
          accountId: e.accountId,
          accountEmail: e.accountEmail || "",
          reason: e.reason || "",
          upstreamStatus: Number(e.upstreamStatus || 0),
          upstreamBody: String(e.upstreamBody || "").slice(0, BODY_MAX),
          modelKey: e.modelKey || "",
          deathStrikes: Number(e.deathStrikes || 0),
          requests: {
            create: snapshot.map((r, i) => ({
              seq: i,
              at: r.at,
              accessKeyId: r.accessKeyId,
              customerId: r.customerId,
              modelKey: r.modelKey,
              status: r.status,
              totalTokens: r.totalTokens,
              reverseProxy: r.reverseProxy,
              surface: r.surface,
              sourceIp: r.sourceIp,
              exitIp: r.exitIp,
            })),
          },
        },
      });
    } catch (err) {
      console.error("[ban-event-tracker] recordBan failed:", err);
    }
  }

  // ── 测试辅助 ──────────────────────────────────────────────────────────────
  ringSizeFor(provider: string, accountId: number): number {
    return (this.rings.get(this.key(provider, accountId)) || []).length;
  }

  ringSnapshotFor(provider: string, accountId: number): readonly RingItem[] {
    return (this.rings.get(this.key(provider, accountId)) || []).slice();
  }
}
