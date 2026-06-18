/**
 * access-key-store.ts — In-memory access key cache with debounced disk persistence.
 *
 * Extracted from remote-token-server/index.js (L325-L868).
 * Encapsulates all access key state: cache, usage recording, and the
 * session-JWT runtime credential resolution (resolveFromRequest).
 */

import * as crypto from 'crypto';
import { readJsonFile, writeJsonFile } from './data-store';
import {
  resetWindowIfExpired,
  resetWeeklyWindowIfExpired,
  tokenWindowMs,
  weeklyTokenLimit,
  weeklyWindowMs as weeklyWindowMsFn,
  weeklyWindowResetMs,
  recentTokenUsage,
  recentBucketUsage,
  recentWeeklyBucketUsage,
  tokenWindowResetMs,
  formatWindowLabel,
  UNIVERSAL_BILLING,
  ProviderBilling,
  keyExpiresAt,
  isAccessKeySessionExpired,
  ACCOUNT_SHARE_CAPACITY,
} from './token-billing';
import {
  bucketFamily,
  bucketsForProducts,
} from '../lease-core/product-bucket';
import {
  looksLikeUserSessionToken,
  missingShadowRecord,
  sessionResolveFailure,
  sessionResolverUnavailable,
  shadowRecordValidationFailure,
  type SessionResolverLike,
} from './session-credential';

export type { SessionResolverLike } from './session-credential';

import {
  requestBucket,
  computeUsageDetail as computeUsageDetailPure,
  bucketUsageInWindow,
  bucketUsageInWindowReadonly,
} from './access-key-limit';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccessKeyRecord {
  id: string;
  key: string;
  name?: string;
  status?: string;
  firstUsedAt?: string;
  durationMs?: number;
  windowMs?: number;
  /** 每模型(复合桶 `<产品>-<家族>`)token 上限。每卡封顶的唯一来源。 */
  bucketLimits?: Record<string, number>;
  windowStartedAt?: number;
  usageEvents?: any[];
  tokenUsageEvents?: any[];
  /** Weekly (long) window fields — independent second tier of rate limiting. */
  weeklyWindowMs?: number;
  weeklyTokenLimit?: number;
  /** Per-composite-bucket weekly token caps. Takes precedence over weeklyTokenLimit. */
  weeklyBucketLimits?: Record<string, number>;
  weeklyWindowStartedAt?: number;
  weeklyTokenUsageEvents?: any[];
  /** Per-product static binding: { codex?: accountId, antigravity?: accountId }.
   * A card may be sold for one or both pools; each entry pins it to one account
   * in that pool. */
  bindings?: Record<string, number>;
  /** Legacy single-binding fields, still read by boundAccountIdFor as a fallback. */
  provider?: string;
  boundAccountId?: number;
  /** Bind-line subscription shadow records MUST hold a seat (binding) to lease (M13b).
   * Set by entitlement-sync on every sync of a bind-line subscription. If seat
   * assignment failed for EVERY product, the record is binding-less and would
   * otherwise fall through to the broad dynamic POOL in LeaseService.leaseToken —
   * access the subscription never sold. The flag makes the lease path 409 instead.
   * Admin pool cards, pool-line subscriptions, and migrated legacy cards never
   * carry it, so their behavior is unchanged. */
  requiresBinding?: boolean;
  /** ABSOLUTE expiry (ISO) — set on subscription shadow records (mirrors
   * Subscription.expiresAt). Takes priority over firstUsedAt+durationMs in
   * keyExpiresAt(). Regular cards never carry it. */
  keyExpiresAt?: string;
  /** Owning account (Customer.id). Set on subscription shadow records by
   *  entitlement-sync; legacy file/pool cards leave it undefined. Used by
   *  reportResult to stamp CardTokenUsage.customerId. */
  customerId?: string;
  /** Account-internal failover order (mirrors Subscription.priority); lower = used
   *  first. Set on subscription shadow records; legacy cards leave it undefined. */
  priority?: number;
  /** Card-migration provenance: set when a legacy card was re-homed to a
   * customer Subscription (bind-card). The record keeps its id (usage/windows
   * carry over); its key is rotated to the subscription's backing key. */
  migratedToCustomerId?: string;
  migratedAt?: string;
  /** Old card key kept for idempotent re-bind lookups ONLY — the byKey auth
   * index is built from `key`, so this value can no longer authenticate. */
  migratedFromKey?: string;
  lastUsedAt?: string;
  activeSessionId?: string;
  sessionClientId?: string;
  sessionStartedAt?: string;
  sessionLastSeenAt?: string;
  sessionExpiresAt?: string;
  sessionTtlMs?: number;
  [k: string]: unknown;
}

export interface AccessKeysData {
  keys: AccessKeyRecord[];
  updatedAt: string;
}

export interface ResolveResult {
  key: string;
  record: AccessKeyRecord | null;
  data?: AccessKeysData;
  error?: string;
  /** 超额(模型/周配额用尽)时为 true,调用方应回 429 而非 401。 */
  limitExceeded?: boolean;
  /** 配额用尽时距窗口重置的毫秒数,用于 Retry-After。 */
  resetMs?: number;
  /** True when the request authenticated with a customer session JWT (the
   * record is a subscription shadow record). Callers skip the per-card
   * single-session machinery for these — multi-device is governed by Device
   * rows + Subscription.deviceLimit instead. */
  viaSession?: boolean;
  /** Machine-readable session failure (SESSION_INVALID / DEVICE_REVOKED /
   * SUBSCRIPTION_EXPIRED) for the client's fatal-error matching. */
  sessionError?: { statusCode: number; code: string };
}

// ── AccessKeyStore ───────────────────────────────────────────────────────────

// Hard cap on the per-card reportId dedup ring (bounds access-keys.json size on
// very busy cards; the ring is also cleared on window reset / pruned in flush).
const MAX_RECENT_REPORT_IDS = 5000;

export class AccessKeyStore {
  private cache: AccessKeysData | null = null;
  private dirty = false;
  // In-memory reportId dedup: cardId → (reportId → seenAt). NOT persisted — keeps
  // access-keys.json from growing with every request. Bounded per card by
  // MAX_RECENT_REPORT_IDS (oldest evicted). A server restart clears it, so the
  // only un-deduped case is a duplicate report arriving after a restart for a
  // report counted before it — negligible (leases are in-memory and also reset).
  private reportDedup = new Map<string, Map<string, number>>();
  // O(1) lookup indexes over cache.keys, rebuilt whenever the cache is (re)loaded.
  // Card membership only changes via (re)load — recordUsage/session updates mutate
  // records in place, so these stay valid without per-write maintenance.
  // byKey is keyed by sha256(key), not the raw key: an O(1) hash lookup preserves
  // the timing-attack resistance the previous constantTimeEqual scan gave (no
  // early-exit byte comparison against the stored secret).
  private byId = new Map<string, AccessKeyRecord>();
  private byKey = new Map<string, AccessKeyRecord>();
  // 去影子:订阅 record 独立于文件 cache —— 不进 access-keys.json,reload 碰不到它们。
  private subscriptionById = new Map<string, AccessKeyRecord>();
  private subscriptionByBackingKey = new Map<string, AccessKeyRecord>();

  constructor(
    private readonly filePath: string,
    private readonly billing: ProviderBilling = UNIVERSAL_BILLING,
  ) {}

  // ── Read / Write ─────────────────────────────────────────────────────────

  readAll(): AccessKeysData {
    if (!this.cache) {
      const parsed = readJsonFile(this.filePath);
      this.cache = {
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        updatedAt: parsed.updatedAt || '',
      };
      this.rebuildIndex();
    }
    return this.cache;
  }

  /** sha256 hex of a key value — the byKey index key (see field comment). */
  private keyHash(value: string): string {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
  }

  // 周上限【只认显式配置】(QUOTA-REDESIGN 决策5):weeklyBucketLimits[bucket] > weeklyTokenLimit。
  // 「cap5h × R 自动派生」整套删除 —— 单一全局倍率 R 无法把 5h 正确换算成周(真实比 3~30
  // 因人而异),那是「周额度纯靠猜」的病根。没配显式周上限的卡,周维度不再有派生封顶。
  private weeklyBucketCap(record: AccessKeyRecord, bucket: string): number {
    const weeklyBucketLimits = record.weeklyBucketLimits && typeof record.weeklyBucketLimits === 'object'
      ? record.weeklyBucketLimits as Record<string, number>
      : {};
    const explicitBucketWeekly = Number(weeklyBucketLimits[bucket] || 0);
    if (explicitBucketWeekly > 0) return explicitBucketWeekly;

    const explicitWeekly = weeklyTokenLimit(record);
    if (explicitWeekly > 0) return this.billing.bucketLimit(explicitWeekly, bucket);

    return 0;
  }

  /** Rebuild byId/byKey from the current cache. Called after every (re)load. */
  private rebuildIndex(): void {
    this.byId.clear();
    this.byKey.clear();
    if (!this.cache) return;
    for (const k of this.cache.keys) {
      if (!k) continue;
      if (k.id) this.byId.set(k.id, k);
      if (k.key) this.byKey.set(this.keyHash(k.key), k);
    }
  }

  /**
   * Reload cache from disk (e.g., after an admin card edit writes the file).
   * The per-request window events are no longer persisted (see serializable()),
   * so they are carried over in memory for cards that still exist by id —
   * otherwise every admin edit (which triggers reload) would reset all rate-limit
   * windows. A full process restart still starts cold and rehydrates from the
   * CardTokenUsage log instead.
   */
  reload(): void {
    const carry = new Map<string, Pick<AccessKeyRecord,
      'usageEvents' | 'tokenUsageEvents' | 'weeklyTokenUsageEvents'>>();
    if (this.cache) {
      for (const k of this.cache.keys) {
        if (!k?.id) continue;
        carry.set(k.id, {
          usageEvents: k.usageEvents,
          tokenUsageEvents: k.tokenUsageEvents,
          weeklyTokenUsageEvents: k.weeklyTokenUsageEvents,
        });
      }
    }
    this.cache = null;
    this.readAll();
    for (const k of this.cache!.keys) {
      const prev = k?.id ? carry.get(k.id) : undefined;
      if (!prev) continue;
      if (prev.usageEvents) k.usageEvents = prev.usageEvents;
      if (prev.tokenUsageEvents) k.tokenUsageEvents = prev.tokenUsageEvents;
      if (prev.weeklyTokenUsageEvents) k.weeklyTokenUsageEvents = prev.weeklyTokenUsageEvents;
    }
    // 订阅 record 在 subscriptionById(独立于文件),reload 天然不碰,无需任何保留逻辑。
  }

  /**
   * 去影子:把 DB 订阅的配置 record 注册进内存(cache + byId),不写 access-keys.json。
   * 已存在同 id(老卡密影子或已注册)→ 只刷新配置字段、保留用量/窗口状态(配置变更
   * 绝不能清零限额)。boot 批量加载 + 订阅激活时调用,使限额引擎无需文件影子即可服务订阅。
   */
  loadSubscriptionRecords(records: Array<Partial<AccessKeyRecord> & { id: string }>): void {
    for (const rec of records) {
      if (!rec?.id) continue;
      const existing = this.subscriptionById.get(rec.id);
      if (existing) {
        // 已存在 → 只刷新配置,保留用量/窗口状态(配置变更绝不能清零限额)。
        const usage = {
          usageEvents: existing.usageEvents,
          tokenUsageEvents: existing.tokenUsageEvents,
          weeklyTokenUsageEvents: existing.weeklyTokenUsageEvents,
          windowStartedAt: existing.windowStartedAt,
          weeklyWindowStartedAt: existing.weeklyWindowStartedAt,
          firstUsedAt: existing.firstUsedAt,
        };
        Object.assign(existing, rec, usage);
      } else {
        this.subscriptionById.set(rec.id, { ...rec } as AccessKeyRecord);
      }
    }
    // 重建 backingKeyValue → record 索引(findByKey 认订阅卡)
    this.subscriptionByBackingKey.clear();
    for (const rec of this.subscriptionById.values()) {
      if (rec.key) this.subscriptionByBackingKey.set(this.keyHash(rec.key), rec);
    }
  }

  /**
   * 从持久化快照(Subscription.windowState)精准恢复某订阅 record 的 5h/周窗口
   * (起点 + 窗口内事件)。重启直接恢复,替代旧的从用量日志回放。
   * stateJson 解析失败/无 record → 安静跳过(冷启动兜底)。
   */
  restoreSubscriptionWindow(id: string, stateJson: string | null | undefined): void {
    if (!id || !stateJson) return;
    const rec = this.subscriptionById.get(id);
    if (!rec) return;
    let s: any;
    try { s = JSON.parse(stateJson); } catch { return; }
    if (!s || typeof s !== "object") return;
    rec.windowStartedAt = Number(s.windowStartedAt || 0) || undefined;
    rec.weeklyWindowStartedAt = Number(s.weeklyWindowStartedAt || 0) || undefined;
    rec.tokenUsageEvents = Array.isArray(s.tokenUsageEvents) ? s.tokenUsageEvents : [];
    rec.weeklyTokenUsageEvents = Array.isArray(s.weeklyTokenUsageEvents) ? s.weeklyTokenUsageEvents : [];
  }

  /**
   * 快照所有订阅 record 的实时 5h/周窗口,供 token-server 定时 + 关机持久化到
   * Subscription.windowState。只输出有窗口活动的订阅(无活动的不写,省 DB)。
   * 行数据小:事件数组本就裁剪在周窗(≤7 天)内。
   */
  serializeSubscriptionWindows(): Array<{ id: string; windowState: string }> {
    const out: Array<{ id: string; windowState: string }> = [];
    for (const rec of this.subscriptionById.values()) {
      if (!rec?.id) continue;
      const hasActivity =
        Number(rec.windowStartedAt || 0) > 0 ||
        Number(rec.weeklyWindowStartedAt || 0) > 0 ||
        (rec.tokenUsageEvents?.length || 0) > 0 ||
        (rec.weeklyTokenUsageEvents?.length || 0) > 0;
      if (!hasActivity) continue;
      out.push({
        id: rec.id,
        windowState: JSON.stringify({
          windowStartedAt: rec.windowStartedAt || 0,
          weeklyWindowStartedAt: rec.weeklyWindowStartedAt || 0,
          tokenUsageEvents: rec.tokenUsageEvents || [],
          weeklyTokenUsageEvents: rec.weeklyTokenUsageEvents || [],
        }),
      });
    }
    return out;
  }

  /**
   * 卡迁移「转化即删」去影子:把刚迁移出来的 DB 订阅配置 record 注册进 subscriptionById,
   * 并把同 id 文件影子卡的实时限流窗口(events + 窗口起点 + firstUsedAt + 累计计数器)平移到
   * 订阅 record 上,然后把文件影子卡从 cache/byId/byKey 物理删除并落盘。
   *
   * 不变量(调用方须保证):已在进程级 withAccessKeysWriteLock 内、DB Subscription 行已提交;
   * 本方法全程同步、无 await —— 与并发 flush/recordUsage 互斥(JS 单线程,debounce flush 的
   * setTimeout 回调不会打断同步段)。平移在删除之前完成 → 删除后 findById 落到订阅 record 时
   * 限流额度连续(不被重置/穿透);老卡 key 在内存(byKey)与文件里同时消失。重启后该订阅由
   * boot 的 loadActiveSubscriptions + restoreSubscriptionWindow(从 Subscription.windowState
   * 精准恢复窗口)接管,口径与此刻平移一致 —— 平移后的窗口由定时持久化写入 windowState。
   */
  migrateCardRecordToSubscription(subRecord: Partial<AccessKeyRecord> & { id: string }): void {
    const id = subRecord.id;
    // 1) 注册订阅配置 record(新 id → 建;已存在 → 刷新配置、保留既有窗口)。
    this.loadSubscriptionRecords([subRecord]);
    // 2) 把文件影子卡的实时窗口/计数器平移到订阅 record —— 务必在删除影子之前。
    const sub = this.subscriptionById.get(id);
    const file = this.byId.get(id);
    if (sub && file) {
      sub.usageEvents = file.usageEvents;
      sub.tokenUsageEvents = file.tokenUsageEvents;
      sub.weeklyTokenUsageEvents = file.weeklyTokenUsageEvents;
      sub.windowStartedAt = file.windowStartedAt;
      sub.weeklyWindowStartedAt = file.weeklyWindowStartedAt;
      sub.firstUsedAt = file.firstUsedAt;
      sub.lastUsedAt = file.lastUsedAt;
    }
    // 3) 物理删除文件影子卡(cache + 两个索引)并落盘。
    this.removeFileRecordById(id);
  }

  /**
   * 从文件 cache + byId + byKey 删除单条卡记录并立即落盘。仅供「转化即删」去影子内部使用:
   * byKey 仅在该项确实指向被删 record 时才删(避免误删同 keyHash 的订阅卡 backingKey 索引)。
   */
  private removeFileRecordById(id: string): void {
    if (!this.cache) this.readAll();
    const rec = this.byId.get(id);
    if (!rec || !this.cache) return;
    this.cache.keys = this.cache.keys.filter((k) => k && k.id !== id);
    this.byId.delete(id);
    if (rec.key) {
      const h = this.keyHash(rec.key);
      if (this.byKey.get(h) === rec) this.byKey.delete(h);
    }
    this.dirty = true;
    this.flush();
  }

  /**
   * 去影子:列出所有已注册的订阅 record(subscriptionById 的快照)。
   * 运行时限额从内存读、不读文件 —— 测试与诊断据此核验注册状态,无需触碰 access-keys.json。
   */
  listSubscriptionRecords(): AccessKeyRecord[] {
    return [...this.subscriptionById.values()];
  }

  /**
   * 列出某 customerId 的所有 ACTIVE 订阅 record,按 priority 升序(小=优先)。
   * 供 SubscriptionScheduler 做账户级接力。只看内存 subscriptionById(订阅卡),
   * 文件卡不参与账户接力(无 customerId)。
   */
  listByCustomerSorted(customerId: string): AccessKeyRecord[] {
    if (!customerId) return [];
    const out: AccessKeyRecord[] = [];
    for (const rec of this.subscriptionById.values()) {
      if (rec.customerId === customerId && String(rec.status || "active") === "active") {
        out.push(rec);
      }
    }
    return out.sort((a, b) => (Number(a.priority ?? 0)) - (Number(b.priority ?? 0)));
  }

  /**
   * 即时更新某订阅 record 的接力优先级(账户中心拖动排序后调用)。
   * 只在 record 已驻留内存时更新 —— 否则该订阅下次从 DB 装载时自带新 priority,
   * 绝不能凭 {id,priority} 往 Map 里塞半截 stub(会污染调度/findByKey)。
   * 返回是否命中,便于调用方判断是否需要 DB 兜底。
   */
  setSubscriptionPriority(id: string, priority: number): boolean {
    const rec = this.subscriptionById.get(id);
    if (!rec) return false;
    rec.priority = Math.max(0, Math.floor(Number(priority) || 0));
    return true;
  }


  /** Immediately flush dirty cache to disk. Only the file-card config store
   *  (cache.keys) is persisted here; runtime usage no longer writes the file —
   *  file cards are retired (don't serve), subscriptions persist via
   *  Subscription.windowState. Used by the migration shadow-delete + admin edits. */
  flush(): void {
    if (!this.dirty || !this.cache) return;
    this.dirty = false;
    try {
      const now = Date.now();
      for (const key of this.cache.keys) {
        if (!key) continue;
        resetWindowIfExpired(key, now);
        const windowStart = Number(key.windowStartedAt || 0);
        if (windowStart > 0) {
          if (Array.isArray(key.usageEvents)) {
            key.usageEvents = key.usageEvents.filter((e: any) => e.at >= windowStart);
          }
          if (Array.isArray(key.tokenUsageEvents)) {
            key.tokenUsageEvents = key.tokenUsageEvents.filter((e: any) => e.at >= windowStart);
          }
        }
        // Prune weekly window events too.
        resetWeeklyWindowIfExpired(key, now);
        const weeklyStart = Number(key.weeklyWindowStartedAt || 0);
        if (weeklyStart > 0 && Array.isArray(key.weeklyTokenUsageEvents)) {
          key.weeklyTokenUsageEvents = key.weeklyTokenUsageEvents.filter((e: any) => e.at >= weeklyStart);
        }
      }
      writeJsonFile(this.filePath, this.serializable());
    } catch (err: any) {
      this.dirty = true;
      console.error(`[access-key-store] flush failed: ${err.message}`);
    }
  }

  /**
   * Disk view of the cache: card metadata + counters, WITHOUT the per-request
   * window event arrays. Those are live rate-limit state kept only in memory —
   * preserved across reload() and rebuilt from the CardTokenUsage log on boot.
   * Omitting them keeps access-keys.json small and, critically, avoids
   * JSON.stringify hitting V8's max-string-length on busy cards.
   */
  private serializable(): AccessKeysData {
    if (!this.cache) return { keys: [], updatedAt: '' };
    return {
      updatedAt: this.cache.updatedAt,
      keys: this.cache.keys.map((k) => {
        if (!k) return k;
        const { usageEvents, tokenUsageEvents, weeklyTokenUsageEvents, ...rest } = k as any;
        return rest as AccessKeyRecord;
      }),
    };
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  findById(cardId: string): AccessKeyRecord | null {
    if (!cardId) return null;
    this.readAll();
    // 文件卡(byId)优先,其次订阅 record(subscriptionById)。
    return this.byId.get(cardId) || this.subscriptionById.get(cardId) || null;
  }

  findByKey(keyValue: string): AccessKeyRecord | null {
    if (!keyValue) return null;
    this.readAll();
    const h = this.keyHash(keyValue);
    return this.byKey.get(h) || this.subscriptionByBackingKey.get(h) || null;
  }

  /**
   * The upstream account id this card is statically bound to within the given
   * pool, or 0 if it isn't bound here. Binding is provider-scoped because the
   * antigravity and codex account pools allocate ids independently (both start
   * at 1), so the same numeric id means different accounts in each pool. An
   * untagged card (no `provider`) matches any pool for backward compatibility.
   */
  boundAccountIdFor(record: AccessKeyRecord, providerId: string): number {
    const map = record?.bindings;
    if (map && typeof map === "object") {
      const fromMap = Number(map[providerId] || 0);
      if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;
    }
    // Legacy single-binding fallback.
    const bound = Number(record?.boundAccountId || 0);
    if (!Number.isFinite(bound) || bound <= 0) return 0;
    if (record.provider && record.provider !== providerId) return 0;
    return bound;
  }

  /**
   * Whether the card has ANY static binding (in any pool). Distinguishes the two
   * card modes: a card with no binding at all is a "pool" card (dynamic pool,
   * legacy); a card bound for a different pool is "not sold for" this pool.
   */
  hasAnyBinding(record: AccessKeyRecord): boolean {
    const map = record?.bindings;
    if (map && typeof map === "object" && Object.values(map).some((v) => Number(v) > 0)) return true;
    return Number(record?.boundAccountId || 0) > 0;
  }

  /**
   * 去影子:绑定到某上游号的「订阅」id(subscriptionById,不写文件)。
   * boundAccountIdFor 读 record.bindings[providerId]。account-system 下用量看板
   * (getBoundCardsForAccount)只列订阅 —— 文件卡已退役、不再混取。号池订阅无
   * bindings,自然不被纳入。
   */
  subscriptionsBoundToAccount(accountId: number, providerId: string): string[] {
    if (accountId <= 0) return [];
    const out: string[] = [];
    for (const rec of this.subscriptionById.values()) {
      if (rec.status && rec.status !== 'active') continue;
      if (this.boundAccountIdFor(rec, providerId) === accountId) out.push(rec.id);
    }
    return out;
  }

  /**
   * 反向索引:返回绑定到某上游号(provider 作用域)的「全量 record 对象」。
   * 同时扫描文件卡(byId)与订阅 record(subscriptionById),按 id 去重(一条
   * record 可能同时落在两个 Map 里)。订阅 record 沿用 subscriptionsBoundToAccount
   * 的 active-status 闸:status 已设且非 'active' 的跳过。fairShare 接力方需读
   * (rec as any).weight / rec.weights,故返回整条 record 而非 id。O(n) 线扫即可,
   * 不额外维护新 Map。
   */
  getRecordsBoundTo(accountId: number, providerId: string): AccessKeyRecord[] {
    if (accountId <= 0) return [];
    const out: AccessKeyRecord[] = [];
    const seen = new Set<string>();
    for (const rec of this.byId.values()) {
      if (seen.has(rec.id)) continue;
      if (rec.status && rec.status !== 'active') continue;   // 与 subscriptionById / hardBoundAccountIds 口径一致:禁用/过期卡不进 Σw,免稀释 e_i
      if (this.boundAccountIdFor(rec, providerId) === accountId) {
        seen.add(rec.id);
        out.push(rec);
      }
    }
    for (const rec of this.subscriptionById.values()) {
      if (seen.has(rec.id)) continue;
      if (rec.status && rec.status !== 'active') continue;
      if (this.boundAccountIdFor(rec, providerId) === accountId) {
        seen.add(rec.id);
        out.push(rec);
      }
    }
    return out;
  }

  /**
   * 严格分池(QUOTA-REDESIGN §3/§7 决策C):所有「硬绑定号」的集合 —— 即被任意 active 硬绑卡
   * (assignmentPolicy ≠ preferred-dynamic)钉住的上游号。轮换 / preferred-dynamic 的候选池
   * 应排除这些号(绑定号只服务自己的主人)。preferred-dynamic 卡自身有 displayBinding 但属软偏好,
   * 不计入硬绑集合。
   */
  hardBoundAccountIds(providerId: string): Set<number> {
    const out = new Set<number>();
    const consider = (rec: AccessKeyRecord) => {
      if (!rec) return;
      if (rec.status && rec.status !== 'active') return;
      if (String((rec as any).assignmentPolicy || '').toLowerCase() === 'preferred-dynamic') return;
      const id = this.boundAccountIdFor(rec, providerId);
      if (id > 0) out.add(id);
    };
    for (const rec of this.byId.values()) consider(rec);
    for (const rec of this.subscriptionById.values()) consider(rec);
    return out;
  }

  /**
   * fair-share Σw 的输入:某号上【硬绑主人】(assignmentPolicy ≠ preferred-dynamic)的份额权重。
   * 排除 preferred-dynamic(它们不进 fair-share 分账,不应稀释 pinned 主人的 e_i=w/D)。
   */
  getHardBoundCardWeights(accountId: number, providerId: string): Array<{ cardId: string; weight: number }> {
    const out: Array<{ cardId: string; weight: number }> = [];
    for (const r of this.getRecordsBoundTo(accountId, providerId)) {
      if (String((r as any).assignmentPolicy || '').toLowerCase() === 'preferred-dynamic') continue;
      const w = Math.floor(Number((r as any).weights?.[providerId] || 0) || Number((r as any).weight ?? 1));
      out.push({ cardId: r.id, weight: Number.isFinite(w) && w >= 1 ? w : 1 });
    }
    return out;
  }

  /**
   * 该号是否被独享订阅独占(有任一硬绑主人 record.exclusive === true)。
   * fair-share 据此把 D 取作 Σw(忽略 N 保底)→ 独享主人 e=1.0,独占整号额度。
   */
  isExclusiveAccount(accountId: number, providerId: string): boolean {
    for (const r of this.getRecordsBoundTo(accountId, providerId)) {
      if (String((r as any).assignmentPolicy || '').toLowerCase() === 'preferred-dynamic') continue;
      if ((r as any).exclusive === true) return true;
    }
    return false;
  }

  /**
   * fair-share 保底席位数 N:取该号硬绑主人 config 里的 salesSeatCapacity[product](拼车销售容量,
   * 目录默认 10);无则回退 ACCOUNT_SHARE_CAPACITY。N 只影响欠卖时的保底/预留(D=max(N,Σw))。
   */
  getSeatCapacityFor(accountId: number, providerId: string): number {
    let cap = 0;
    for (const r of this.getRecordsBoundTo(accountId, providerId)) {
      if (String((r as any).assignmentPolicy || '').toLowerCase() === 'preferred-dynamic') continue;
      const c = Math.floor(Number((r as any).salesSeatCapacity?.[providerId] || 0));
      if (Number.isFinite(c) && c > cap) cap = c;
    }
    return cap > 0 ? cap : ACCOUNT_SHARE_CAPACITY;
  }

  // ── Request resolution ─────────────────────────────────────────────────

  /** Injected session-JWT → subscription resolver (see SessionResolverLike). */
  private sessionResolver: SessionResolverLike | null = null;

  /** Wire the customer-session resolver. Called from a Nest OnModuleInit (the
   * store is a plain class shared across pools and can't use DI itself). */
  setSessionResolver(resolver: SessionResolverLike | null): void {
    this.sessionResolver = resolver;
  }

  /**
   * Resolve the runtime credential from a request, checking validity and limits.
   *
   * The ONLY runtime credential is the customer session JWT: an Authorization
   * bearer that LOOKS like a user-session token routes to the injected
   * SessionTokenResolver, which verifies it and maps it to the customer's
   * ACTIVE Subscription — whose id IS the shadow record id. The record then
   * runs the shared validation pipeline (status/expiry/window/bucket/weekly).
   *
   * Card-string credentials (x-token-server-secret / x-access-key / payload
   * key fields) were removed with the force-upgrade — clients below 9.5.0 are
   * upgraded away and no longer served. Card VALUES still resolve via
   * findByKey() for the bind-card redemption flow (card-migration.service),
   * which converts a legacy card into a Subscription; they just can no longer
   * LEASE directly.
   */
  async resolveFromRequest(
    req: any,
    _payload: any,
    options: { activate?: boolean; enforceLimit?: boolean; modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number) } = {},
  ): Promise<ResolveResult> {
    const authHeader = String(req?.headers?.authorization || '');
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!looksLikeUserSessionToken(bearer)) {
      return {
        key: '',
        record: null,
        error: bearer ? 'Invalid access key' : 'Missing access key',
      };
    }

    const data = this.readAll();
    if (!this.sessionResolver) return sessionResolverUnavailable();
    const resolved = await this.sessionResolver.resolve(bearer, { product: options.product });
    if (!resolved.ok) return sessionResolveFailure(resolved);
    const record = this.byId.get(resolved.cardId) || this.subscriptionById.get(resolved.cardId) || null;
    if (!record) return missingShadowRecord();
    // Migrated never-used card: no absolute expiry AND not yet armed.
    const unarmed = !record.keyExpiresAt && !record.firstUsedAt;
    const result: ResolveResult = { ...this.validateRecord(String(record.key || ''), record, data, options), viaSession: true };
    // This lease just armed firstUsedAt → tell the resolver the record's
    // now-effective expiry so Subscription.expiresAt gets resynced. Fires at
    // most ONCE per record (firstUsedAt persists) and is NOT awaited — zero
    // added latency on the hot path; the hook owns its errors.
    if (unarmed && result.record && record.firstUsedAt) {
      const effective = keyExpiresAt(record);
      if (effective) this.sessionResolver.onShadowRecordFirstUse?.(record.id, effective);
    }
    // Record-level expiry/disabled on the session path → SUBSCRIPTION_EXPIRED
    // machine code (the sub row was ACTIVE but the record can't serve).
    return shadowRecordValidationFailure(result);
  }

  /**
   * Shared validation pipeline for a looked-up record: status → activation →
   * expiry → window resets → per-bucket caps (429 w/ resetMs) → weekly window.
   * Extracted verbatim from the historical resolveFromRequest body; the
   * session path runs records through it unchanged.
   */
  private validateRecord(
    keyValue: string,
    record: AccessKeyRecord,
    data: AccessKeysData,
    options: { activate?: boolean; enforceLimit?: boolean; modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); dryRun?: boolean } = {},
  ): ResolveResult {
    if (record.status && record.status !== 'active') {
      return { key: keyValue, record: null, error: 'Access key disabled' };
    }

    const now = Date.now();
    if (!record.firstUsedAt && options.activate) {
      record.firstUsedAt = new Date(now).toISOString();
    }
    const expiresAt = keyExpiresAt(record);
    if (expiresAt && Date.parse(expiresAt) <= now) {
      if (!options.dryRun) record.status = 'expired';
      return { key: keyValue, record: null, error: 'Access key expired' };
    }

    // Bound cards align each bucket to its account window (alignedResetAt); the
    // global tumbling reset must be skipped for them, or it would wipe events the
    // aligned per-bucket window still needs.
    const aligned = typeof options.alignedResetAt === 'function'
      ? (Number(options.alignedResetAt(record)) || 0)
      : (Number(options.alignedResetAt) || 0);
    if (aligned <= 0) resetWindowIfExpired(record, now);

    // 每卡封顶的唯一来源:bucketLimits(按复合桶 `<产品>-<家族>` 设的每模型上限)。
    const hasBucketCaps =
      !!record.bucketLimits &&
      typeof record.bucketLimits === 'object' &&
      Object.values(record.bucketLimits).some((v) => Number(v) > 0);

    if (options.enforceLimit && hasBucketCaps) {
      const modelKeyStr = String(options.modelKey || '').trim();

      if (modelKeyStr) {
        const bucket = requestBucket(options.product, modelKeyStr);
        const limit = this.billing.bucketLimit(0, bucket, record);
        // Bound (aligned) cards count usage within the account-aligned window;
        // pool cards use the global fixed-period window.
        const used = aligned > 0
          ? bucketUsageInWindow(record, bucket, now, aligned)
          : (recentBucketUsage(record, now).get(bucket) || 0);
        if (limit > 0 && used >= limit) {
          const windowLabel = aligned > 0 ? '账号窗口' : formatWindowLabel(record.windowMs);
          const resetMs = aligned > 0 ? Math.max(0, aligned - now) : tokenWindowResetMs(record, now);
          return {
            key: keyValue, record: null,
            limitExceeded: true, resetMs,
            error: `Access key ${this.billing.bucketLabel(bucket)} token limit exceeded (${used}/${limit} tokens/${windowLabel})`,
          };
        }
      }
      // 无 modelKey(预热 / 探活)不消费任何具体桶 → 不做额度拦截。真实消费都带 modelKey,走上面
      // 的精确单桶检查:某个产品的桶爆了只拦那个产品(anthropic-claude 爆只拦 claude),绝不连累
      // 其他满额产品(antigravity-gemini 0/10000)或没设限的产品。这彻底消除「用过的桶爆 → 判整
      // 卡死 → 锁住整张卡(含满额产品)的预热」这种跨产品污染。
    }

    // ── Weekly window check (second tier) ──────────────────────────────────
    // 周上限【只认显式配置】(QUOTA-REDESIGN 决策5):weeklyTokenLimit / weeklyBucketLimits。
    // 「cap5h × R 自动派生」已删除(R 无法正确换算 5h→周)。没配显式周上限 → 周维度不拦。
    resetWeeklyWindowIfExpired(record, now);
    if (options.enforceLimit) {
      const modelKeyStr = String(options.modelKey || '').trim();
      // 无 modelKey(预热/探活)不消费具体桶 → 不拦截(理由同 5h 窗口)。
      if (modelKeyStr) {
        const bucket = requestBucket(options.product, modelKeyStr);
        const weeklyCap = this.weeklyBucketCap(record, bucket);
        if (weeklyCap > 0) {
          const used = recentWeeklyBucketUsage(record, now).get(bucket) || 0;
          if (used >= weeklyCap) {
            return {
              key: keyValue, record: null,
              limitExceeded: true, resetMs: weeklyWindowResetMs(record, now),
              error: `Access key ${this.billing.bucketLabel(bucket)} weekly token limit exceeded (${used}/${weeklyCap} tokens/week)`,
            };
          }
        }
      }
    }

    return { key: keyValue, record, data };
  }

  /**
   * 只读三道闸预检(bucketLimits + weekly + expiry/status),供 SubscriptionScheduler
   * 对候选订阅逐个判断"当前 bucket 还有没有额度"。复用 validateRecord 的 dryRun 模式,
   * 绝不写缓存、不改 record 状态。fair-share(第三道闸)由 scheduler 另调 checkFairShare。
   */
  precheckRecord(
    record: AccessKeyRecord,
    options: { modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); enforceLimit?: boolean },
  ): { allowed: boolean; resetMs?: number; reason?: string } {
    const res = this.validateRecord(String(record.key || record.id), record, this.readAll(), {
      ...options,
      enforceLimit: options.enforceLimit ?? true,
      dryRun: true,
    });
    if (res.record) return { allowed: true };
    return { allowed: false, resetMs: res.resetMs, reason: res.error };
  }

  // ── Usage recording ────────────────────────────────────────────────────

  /**
   * Normalize a raw usage payload into the canonical token counts (and billing
   * bucket) that recordUsage() persists. Exposed so callers (e.g. the per-call
   * token-usage tracker) record EXACTLY the same numbers as the card counters.
   */
  computeUsageDetail(usage: any = {}, modelKey = '', product = '') {
    return computeUsageDetailPure(usage, modelKey, product);
  }

  /**
   * Record a usage report against a card. Idempotent by reportId: a reportId
   * already seen within the current usage window is NOT counted again, and the
   * method returns false. Returns true when this report was newly counted.
   *
   * Dedup uses an in-memory ring (reportDedup) keyed by card+reportId, so it
   * survives lease expiry (a retried/late report for a long-gone lease is still
   * deduplicated) WITHOUT bloating access-keys.json. Reports without a reportId
   * (legacy clients) cannot be deduped here; the caller handles their
   * once-per-success semantics via lease.successfulReportSeen.
   */
  recordUsage(cardId: string, status: number, usage: any = {}, modelKey = '', reportId = '', product = ''): boolean {
    if (!cardId) return false;
    const record = this.findById(cardId);
    if (!record) return false;

    const now = Date.now();
    resetWindowIfExpired(record, now);

    if (reportId) {
      let seen = this.reportDedup.get(cardId);
      if (!seen) { seen = new Map(); this.reportDedup.set(cardId, seen); }
      if (seen.has(reportId)) return false; // duplicate — already counted
      seen.set(reportId, now);
      // Bound memory: evict oldest (Map preserves insertion order).
      while (seen.size > MAX_RECENT_REPORT_IDS) {
        const oldest = seen.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    }

    const { inputTokens, outputTokens, cachedInputTokens, rawTotalTokens, totalTokens } =
      this.computeUsageDetail(usage, modelKey, product);

    // 累计用量计数已下线:权威用量在 CardUsageHourly(DB)。这里只更新限流窗口事件
    // (下方)+ lastUsedAt;后台单卡「总Token/请求数」改读 CardUsageHourly。
    record.lastUsedAt = new Date(now).toISOString();

    if (!record.usageEvents) record.usageEvents = [];
    record.usageEvents.push({ at: now, status: Number(status || 0) });

    if (totalTokens > 0) {
      if (!record.tokenUsageEvents) record.tokenUsageEvents = [];
      record.tokenUsageEvents.push({
        at: now, status: Number(status || 0),
        inputTokens, outputTokens, cachedInputTokens,
        rawTotalTokens, totalTokens, modelKey: modelKey || '', product: product || '',
      });

      // Weekly window: dual-write the same event into the weekly array.
      resetWeeklyWindowIfExpired(record, now);
      if (!record.weeklyTokenUsageEvents) record.weeklyTokenUsageEvents = [];
      record.weeklyTokenUsageEvents.push({
        at: now, status: Number(status || 0),
        inputTokens, outputTokens, cachedInputTokens,
        rawTotalTokens, totalTokens, modelKey: modelKey || '', product: product || '',
      });
    }

    // 用量上报【一律不落 access-keys.json】(运行时不写文件):
    // 用量明细走 DB(CardUsageHourly,见 token-usage-tracker);订阅卡的 5h/周窗口走
    // Subscription.windowState(重启精准恢复);文件卡已退役、不再发号也不再持久化用量。
    // access-keys.json 仅作【卡密配置】存储,只在 admin 增删改卡 + 卡密转订阅删影子时写。
    // 此处只就地更新 record 内存计数,供本进程 publicStatus 展示。
    return true;
  }

  // ── Public status ────────────────────────────────────────────────────────
  // The per-card single-session machinery (validateSession/refreshSession) was
  // removed with the card-string runtime credential: session-JWT leases govern
  // multi-device via Device rows + Subscription.deviceLimit instead. The
  // record's session* fields remain as historical data; publicStatus still
  // surfaces hasActiveSession from them for old records.

  /** Get public-safe status for an access key. 周数据仅来自显式 weeklyTokenLimit/weeklyBucketLimits
   *  (决策5:cap5h×R 派生已删)。 */
  publicStatus(record: AccessKeyRecord, alignedResetAt = 0): any {
    if (!record) return null;
    const now = Date.now();
    const aligned = Number(alignedResetAt || 0) > 0;
    if (!aligned) resetWindowIfExpired(record, now);
    const recentTokens = aligned ? null : recentTokenUsage(record, now);
    // Bound cards align their window to the account's upstream reset; the client
    // back-derives its local-quota window end from this, so it must match the
    // server's aligned window rather than the global fixed-period one.
    const resetMs = alignedResetAt > 0 ? Math.max(0, alignedResetAt - now) : tokenWindowResetMs(record, now);
    const expiresAt = keyExpiresAt(record);

    // Weekly window【只认显式 weeklyTokenLimit / weeklyBucketLimits】(决策5);cap5h×R 派生已删。
    resetWeeklyWindowIfExpired(record, now);
    const wkLimit = weeklyTokenLimit(record);
    const weeklyCapFor = (bucket: string): number => {
      return this.weeklyBucketCap(record, bucket);
    };

    // 是否设了每模型上限(bucketLimits 中有任何 >0 的桶)。
    const hasBucketCaps =
      !!record.bucketLimits &&
      typeof record.bucketLimits === 'object' &&
      Object.values(record.bucketLimits).some((v) => Number(v) > 0);

    // Products the card is sold for (bindings keys with a real account id,
    // or explicit products array for universal cards). Empty = pool card / all products.
    const products = record.bindings && typeof record.bindings === 'object'
      ? Object.keys(record.bindings).filter((p) => Number((record.bindings as Record<string, number>)[p]) > 0)
      : (Array.isArray((record as any).products) ? (record as any).products : []);

    // quotaMode tells the client which quota system to use:
    //   static    — card has per-model caps (bucketLimits), use localQuota
    //   dynamic   — bound card without caps, fair-share + upstream controls quota
    //   unlimited — no caps, no binding
    const quotaMode = hasBucketCaps ? 'static' : (this.hasAnyBinding(record) ? 'dynamic' : 'unlimited');

    // Composite product-family buckets this card can use. Sum usage by family for
    // the legacy flat fields below (kept until clients consume `buckets` directly).
    const enumBuckets = bucketsForProducts(products);
    const bucketUsage = aligned
      ? new Map(enumBuckets.map((bucket) => [bucket, bucketUsageInWindowReadonly(record, bucket, now, alignedResetAt)]))
      : recentBucketUsage(record, now);
    const recentTotalTokens = [...bucketUsage.values()].reduce((sum, v) => sum + v, 0);
    const familyUsed = (family: string): number => {
      let sum = 0;
      for (const [k, v] of bucketUsage) if (bucketFamily(k) === family) sum += v;
      return sum;
    };
    // 每家族的扁平上限(下发客户端):取 bucketLimits 中该家族各复合桶的最大值。
    // 服务端按复合桶精确兜底,扁平字段仅供客户端 localQuota 快速本地拦截。
    const familyLimit = (family: string): number => {
      let max = 0;
      const bl = (record.bucketLimits && typeof record.bucketLimits === 'object')
        ? (record.bucketLimits as Record<string, number>) : {};
      for (const [k, v] of Object.entries(bl)) {
        if (bucketFamily(k) === family) max = Math.max(max, Number(v) || 0);
      }
      return max;
    };

    // 周桶(显式或派生);任一桶有周上限即视为有周窗口,据此算用量与 reset。
    const weeklyBucketsOut = enumBuckets
      .map((bucket) => ({ bucket, limit: weeklyCapFor(bucket) }))
      .filter((b) => b.limit > 0);
    const hasWeekly = weeklyBucketsOut.length > 0;
    const wkBucketUsage = hasWeekly ? recentWeeklyBucketUsage(record, now) : new Map<string, number>();
    const wkResetMs = hasWeekly ? weeklyWindowResetMs(record, now) : 0;

    return {
      id: record.id,
      name: record.name || '',
      status: record.status || 'active',
      quotaMode,
      products,
      firstUsedAt: record.firstUsedAt || '',
      expiresAt,
      remainingMs: expiresAt ? Math.max(0, Date.parse(expiresAt) - now) : 0,
      // 累计计数已下线(权威用量在 CardUsageHourly)。recentWindowTokens 仍是限流窗口
      // 的当前用量(内存),客户端额度展示与限流判断都靠它,保留。
      recentWindowTokens: aligned ? recentTotalTokens : recentTokens!.totalTokens,
      // Legacy flat fields (older client contract). Each is the sum across the
      // composite buckets of that family — kept until clients read `buckets`
      // directly. opus≈claude family, gemini, codex≈gpt family.
      opusTokensUsed: familyUsed('claude'),
      opusTokenLimit: familyLimit('claude'),
      geminiTokensUsed: familyUsed('gemini'),
      geminiTokenLimit: familyLimit('gemini'),
      codexTokensUsed: familyUsed('gpt'),
      codexTokenLimit: familyLimit('gpt'),
      // Composite product-family per-bucket view (the authoritative shape).
      buckets: enumBuckets.map((bucket) => ({
        bucket,
        used: bucketUsage.get(bucket) || 0,
        limit: this.billing.bucketLimit(0, bucket, record),
      })),
      tokenWindowMs: tokenWindowMs(record),
      tokenWindowResetMs: resetMs,
      tokenWindowResetAt: resetMs > 0 ? new Date(now + resetMs).toISOString() : '',
      // Weekly window status — 显式 weeklyTokenLimit 或派生(5h×R, anthropic/codex)时有数据。
      weeklyTokenLimit: wkLimit,
      weeklyWindowMs: hasWeekly ? weeklyWindowMsFn(record) : 0,
      weeklyWindowResetMs: wkResetMs,
      weeklyWindowResetAt: wkResetMs > 0 ? new Date(now + wkResetMs).toISOString() : '',
      weeklyBuckets: weeklyBucketsOut.map((b) => ({
        bucket: b.bucket,
        used: wkBucketUsage.get(b.bucket) || 0,
        limit: b.limit,
        weeklyWindowResetMs: wkResetMs,
        weeklyWindowResetAt: wkResetMs > 0 ? new Date(now + wkResetMs).toISOString() : '',
      })),
      hasActiveSession: Boolean(
        record.activeSessionId && !isAccessKeySessionExpired(record, now),
      ),
      lastUsedAt: record.lastUsedAt || '',
      // 卡级 fair-share 份额:weight = 这张卡占的份数,shareCapacity = 号总份数(默认 8)。
      // 客户端「我的卡 · 份额」条展开显示「份额 weight/shareCapacity」。
      weight: Math.max(1, Math.floor(Number((record as any).weight) || 1)),
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      // 独享:权威标志,客户端「尊贵·独享」badge 据此(不再靠 weight>=capacity 推断)。
      exclusive: (record as any).exclusive === true,
    };
  }
}
