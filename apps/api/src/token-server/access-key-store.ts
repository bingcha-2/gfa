/**
 * access-key-store.ts — In-memory access key cache with debounced disk persistence.
 *
 * Extracted from remote-token-server/index.js (L325-L868).
 * Encapsulates all access key state: cache, session, usage recording.
 */

import * as crypto from 'crypto';
import { readJsonFile, writeJsonFile, constantTimeEqual } from './data-store';
import {
  readTokenCount,
  billableTokenUsageTotal,
  eventUsageForLimit,
  normalizeUsageToGross,
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
  bucketWindowStart,
  UNIVERSAL_BILLING,
  ProviderBilling,
  keyExpiresAt,
  isAccessKeySessionExpired,
  DEFAULT_KEY_SESSION_TTL_MS,
  ACCESS_KEY_BINDING_GRACE_MS,
  ACCOUNT_SHARE_CAPACITY,
} from './token-billing';
import {
  bucketKey,
  modelFamily,
  bucketFamily,
  bucketsForProducts,
  productOfBucket,
} from '../lease-core/product-bucket';
import { DEFAULT_WEEKLY_RATIO } from '../lease-core/quota-profile-tracker';

/** Bucket key for the model a request is asking for, scoped to the product
 *  serving it. Falls back to bare family when product is unknown (legacy path). */
function requestBucket(product: string | undefined, modelKey: string): string {
  return product ? bucketKey(product, modelKey) : modelFamily(modelKey);
}

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
  weeklyWindowStartedAt?: number;
  weeklyTokenUsageEvents?: any[];
  /** Per-product static binding: { codex?: accountId, antigravity?: accountId }.
   * A card may be sold for one or both pools; each entry pins it to one account
   * in that pool. */
  bindings?: Record<string, number>;
  /** Legacy single-binding fields, still read by boundAccountIdFor as a fallback. */
  provider?: string;
  boundAccountId?: number;
  totalRequests?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedInputTokens?: number;
  totalRawTokensUsed?: number;
  totalTokensUsed?: number;
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
}

export interface SessionValidation {
  ok: boolean;
  action?: string;
  error?: string;
  statusCode?: number;
  requestedSessionId?: string;
  sessionClientId?: string;
  sessionExpiresAt?: string;
  sameClientSessionReuse?: boolean;
  sameClientGrace?: boolean;
}

// ── AccessKeyStore ───────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 10_000;
// Hard cap on the per-card reportId dedup ring (bounds access-keys.json size on
// very busy cards; the ring is also cleared on window reset / pruned in flush).
const MAX_RECENT_REPORT_IDS = 5000;

export class AccessKeyStore {
  private cache: AccessKeysData | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
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
  }

  /**
   * Rebuild in-memory rate-limit windows from the durable CardTokenUsage log.
   * Called ONCE on boot: window events are not persisted to access-keys.json
   * (see serializable()), so without this a restart would reset every card's
   * usage window and hand out fresh quota. Rows should be pre-scoped to the
   * relevant window by the caller; over-supplied rows are harmless since the
   * window reads filter by timestamp anyway. Only cards present in the cache are
   * hydrated. The reconstructed events carry `product` (derived from the row's
   * bucket when absent) and `modelKey` so the bucket read re-derives the same
   * billing bucket the row was recorded under.
   */
  hydrateWindowsFromUsageLog(
    rows: Array<{
      accessKeyId: string;
      at: number;
      status?: number;
      modelKey?: string;
      bucket?: string;
      product?: string;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      rawTotalTokens?: number;
      totalTokens?: number;
    }>,
  ): void {
    this.readAll();
    for (const row of rows) {
      if (!row?.accessKeyId) continue;
      const record = this.byId.get(row.accessKeyId);
      if (!record) continue;
      const bucket = String(row.bucket || '');
      const product = row.product != null
        ? String(row.product)
        : (bucket.includes('-') ? bucket.slice(0, bucket.indexOf('-')) : '');
      const ev = {
        at: Number(row.at || 0),
        status: Number(row.status || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        cachedInputTokens: Number(row.cachedInputTokens || 0),
        rawTotalTokens: Number(row.rawTotalTokens || 0),
        totalTokens: Number(row.totalTokens || 0),
        modelKey: row.modelKey || '',
        product,
      };
      if (!record.tokenUsageEvents) record.tokenUsageEvents = [];
      record.tokenUsageEvents.push(ev);
      if (!record.weeklyTokenUsageEvents) record.weeklyTokenUsageEvents = [];
      record.weeklyTokenUsageEvents.push(ev);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, SAVE_DEBOUNCE_MS);
    }
  }

  private writeCache(): void {
    if (!this.cache) return;
    this.cache.updatedAt = new Date().toISOString();
    this.markDirty();
  }

  /** Immediately flush dirty cache to disk. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
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
    return this.byId.get(cardId) || null;
  }

  findByKey(keyValue: string): AccessKeyRecord | null {
    if (!keyValue) return null;
    this.readAll();
    return this.byKey.get(this.keyHash(keyValue)) || null;
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

  /** Find all active card IDs bound to the same upstream account in a given pool. */
  cardsBoundToAccount(accountId: number, providerId: string): string[] {
    if (accountId <= 0) return [];
    const data = this.readAll();
    return data.keys
      .filter((k) => (!k.status || k.status === 'active') && this.boundAccountIdFor(k, providerId) === accountId)
      .map((k) => k.id);
  }

  // ── Request resolution ─────────────────────────────────────────────────


  /** Extract access key from an HTTP request. */
  static extractKeyFromRequest(req: any, payload: any): string {
    const auth = String(req.headers?.authorization || '');
    const bearer = auth.replace(/^Bearer\s+/i, '').trim();
    return String(
      req.headers?.['x-token-server-secret'] ||
      req.headers?.['x-access-key'] ||
      payload?.accessKey ||
      payload?.accountCard ||
      payload?.cardKey ||
      payload?.key ||
      bearer ||
      '',
    ).trim();
  }

  /** Resolve an access key from a request, checking validity and limits. */
  resolveFromRequest(
    req: any,
    payload: any,
    options: { activate?: boolean; enforceLimit?: boolean; modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); weeklyRatio?: number | ((record: any) => number) } = {},
  ): ResolveResult {
    const keyValue = AccessKeyStore.extractKeyFromRequest(req, payload);
    if (!keyValue) return { key: keyValue, record: null, error: 'Missing access key' };

    const data = this.readAll();
    const record = this.byKey.get(this.keyHash(keyValue)) || null;
    if (!record) return { key: keyValue, record: null, error: 'Invalid access key' };
    if (record.status && record.status !== 'active') {
      return { key: keyValue, record: null, error: 'Access key disabled' };
    }

    const now = Date.now();
    if (!record.firstUsedAt && options.activate) {
      record.firstUsedAt = new Date(now).toISOString();
    }
    const expiresAt = keyExpiresAt(record);
    if (expiresAt && Date.parse(expiresAt) <= now) {
      record.status = 'expired';
      this.writeCache();
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
          ? this.bucketUsageInWindow(record, bucket, now, aligned)
          : (recentBucketUsage(record, now).get(bucket) || 0);
        if (limit > 0 && used >= limit) {
          this.writeCache();
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
    // 周上限两种来源:① 显式 weeklyTokenLimit(手填,优先,兼容老逻辑);
    // ② 否则对 anthropic/codex 桶按「5h 上限 × R」自动派生(池子卡也由此获得周限额)。
    // R = 卡设置框 > 后台学习 > 全局默认,由调用方经 options.weeklyRatio(回调)解析。
    resetWeeklyWindowIfExpired(record, now);
    if (options.enforceLimit) {
      const modelKeyStr = String(options.modelKey || '').trim();
      // 无 modelKey(预热/探活)不消费具体桶 → 不拦截(理由同 5h 窗口)。
      if (modelKeyStr) {
        const bucket = requestBucket(options.product, modelKeyStr);
        const explicitWeekly = weeklyTokenLimit(record);
        let weeklyCap = 0;
        if (explicitWeekly > 0) {
          weeklyCap = this.billing.bucketLimit(explicitWeekly, bucket, record);
        } else {
          const cap5h = this.billing.bucketLimit(0, bucket, record); // = bucketLimits[bucket] 或 0
          const product = productOfBucket(bucket);
          if (cap5h > 0 && (product === 'anthropic' || product === 'codex')) {
            const rawR = typeof options.weeklyRatio === 'function'
              ? Number(options.weeklyRatio(record))
              : Number(options.weeklyRatio);
            const ratio = Number.isFinite(rawR) && rawR > 0 ? rawR : DEFAULT_WEEKLY_RATIO;
            weeklyCap = cap5h * ratio;
          }
        }
        if (weeklyCap > 0) {
          const used = recentWeeklyBucketUsage(record, now).get(bucket) || 0;
          if (used >= weeklyCap) {
            this.writeCache();
            return {
              key: keyValue, record: null,
              limitExceeded: true, resetMs: weeklyWindowResetMs(record, now),
              error: `Access key ${this.billing.bucketLabel(bucket)} weekly token limit exceeded (${used}/${weeklyCap} tokens/week)`,
            };
          }
        }
      }
    }

    if (options.activate) this.writeCache();
    return { key: keyValue, record, data };
  }

  // ── Usage recording ────────────────────────────────────────────────────

  /**
   * Normalize a raw usage payload into the canonical token counts (and billing
   * bucket) that recordUsage() persists. Exposed so callers (e.g. the per-call
   * token-usage tracker) record EXACTLY the same numbers as the card counters.
   */
  computeUsageDetail(usage: any = {}, modelKey = '', product = '') {
    // 单点收口:先按模型家族把上报归一成 gross input 口径,计费与拼车两条链共享同一份。
    const norm = normalizeUsageToGross(usage, modelKey);
    const inputTokens = readTokenCount(norm.inputTokens);
    const outputTokens = readTokenCount(norm.outputTokens);
    const cachedInputTokens = readTokenCount(norm.cachedInputTokens);
    const rawTotalTokens = readTokenCount(norm.rawTotalTokens) || inputTokens + outputTokens;
    const totalTokens = billableTokenUsageTotal(
      { ...norm, inputTokens, outputTokens, cachedInputTokens, rawTotalTokens },
      modelKey,
    );
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      rawTotalTokens,
      totalTokens,
      bucket: requestBucket(product, modelKey || ''),
    };
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
  /** Token usage for ONE bucket within its current window. Bound cards align the
   *  window to the account's upstream reset (alignedResetAt); alignedResetAt<=0 →
   *  fixed-period (pool). Sums the bucket's events with `at >= window start`. */
  private bucketUsageInWindow(record: any, bucket: string, now: number, alignedResetAt: number): number {
    const windowStart = bucketWindowStart(record, bucket, now, alignedResetAt, Number(record.windowMs) || undefined);
    let used = 0;
    for (const item of record.tokenUsageEvents || []) {
      if (Number(item?.at || 0) < windowStart) continue;
      if (requestBucket(String(item?.product || ''), String(item?.modelKey || '')) !== bucket) continue;
      // anthropic/codex → CU(加权);antigravity → 原始。与 recentBucketUsage 口径一致。
      used += eventUsageForLimit(item);
    }
    return used;
  }

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

    record.totalRequests = Number(record.totalRequests || 0) + 1;
    record.totalInputTokens = Number(record.totalInputTokens || 0) + inputTokens;
    record.totalOutputTokens = Number(record.totalOutputTokens || 0) + outputTokens;
    record.totalCachedInputTokens = Number(record.totalCachedInputTokens || 0) + cachedInputTokens;
    record.totalRawTokensUsed = Number(record.totalRawTokensUsed || 0) + rawTotalTokens;
    record.totalTokensUsed = Number(record.totalTokensUsed || 0) + totalTokens;
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

    this.markDirty();
    return true;
  }

  // ── Session management ─────────────────────────────────────────────────

  private static makeSessionId(): string {
    return `sess_${Date.now().toString(36)}_${crypto.randomBytes(12).toString('hex')}`;
  }

  private static normalizeSessionId(value: unknown): string {
    return String(value || '').trim();
  }

  /** Validate whether a session request is allowed. */
  validateSession(record: AccessKeyRecord, payload: any, now = Date.now()): SessionValidation {
    const requestedSessionId = AccessKeyStore.normalizeSessionId(
      payload?.sessionId || payload?.accessKeySessionId || payload?.relayProxySessionId,
    );
    const requestedClientId = String(payload?.clientId || payload?.client || '').trim();
    const activeSessionId = AccessKeyStore.normalizeSessionId(record.activeSessionId);

    if (!activeSessionId || isAccessKeySessionExpired(record, now)) {
      return { ok: true, action: 'create', requestedSessionId };
    }
    if (requestedSessionId && constantTimeEqual(requestedSessionId, activeSessionId)) {
      const activeClientId = String(record.sessionClientId || '').trim();
      if (!requestedClientId) {
        return {
          ok: false, error: 'Access key session requires client identity',
          statusCode: 409, sessionClientId: activeClientId,
          sessionExpiresAt: record.sessionExpiresAt || '',
        };
      }
      if (activeClientId && requestedClientId !== activeClientId) {
        return {
          ok: false, error: 'Access key session belongs to another client',
          statusCode: 409, sessionClientId: activeClientId,
          sessionExpiresAt: record.sessionExpiresAt || '',
        };
      }
      return { ok: true, action: 'refresh', requestedSessionId };
    }

    const activeClientId = String(record.sessionClientId || '').trim();
    if (requestedClientId && activeClientId && requestedClientId === activeClientId) {
      return { ok: true, action: 'reuse', requestedSessionId, sameClientSessionReuse: true };
    }

    const sessionStartedAt = Date.parse(record.sessionStartedAt || '');
    const withinGrace =
      Number.isFinite(sessionStartedAt) &&
      now - sessionStartedAt >= 0 &&
      now - sessionStartedAt <= ACCESS_KEY_BINDING_GRACE_MS;
    if (!requestedSessionId && requestedClientId && activeClientId &&
        requestedClientId === activeClientId && withinGrace) {
      return { ok: true, action: 'reuse', requestedSessionId, sameClientGrace: true };
    }

    return {
      ok: false, error: 'Access key is already active on another device',
      statusCode: 409, sessionClientId: record.sessionClientId || '',
      sessionExpiresAt: record.sessionExpiresAt || '',
    };
  }

  /** Refresh or create a session for a record. */
  refreshSession(
    record: AccessKeyRecord,
    payload: any,
    now = Date.now(),
    options: { create?: boolean; rotate?: boolean } = {},
  ): string {
    // 直接用全局默认(env 可调),不读 record.sessionTtlMs —— 否则老卡上持久化的旧值
    // 会把它「粘住」,改默认对存量卡不生效。每次刷新都回写当前默认,存量卡下次请求即自愈。
    const ttlMs = DEFAULT_KEY_SESSION_TTL_MS;
    const clientId = String(payload?.clientId || payload?.client || '').trim();
    const hasLiveSession =
      AccessKeyStore.normalizeSessionId(record.activeSessionId) &&
      !isAccessKeySessionExpired(record, now);
    const shouldCreate = Boolean(options.create) || !hasLiveSession;
    const shouldRotate = Boolean(options.rotate);

    if (shouldCreate || shouldRotate) {
      record.activeSessionId = AccessKeyStore.makeSessionId();
      record.sessionStartedAt = new Date(now).toISOString();
      record.sessionClientId = clientId;
    } else {
      record.activeSessionId =
        AccessKeyStore.normalizeSessionId(record.activeSessionId) || AccessKeyStore.makeSessionId();
      if (!record.sessionClientId && clientId) record.sessionClientId = clientId;
      record.sessionStartedAt = record.sessionStartedAt || new Date(now).toISOString();
    }
    record.sessionLastSeenAt = new Date(now).toISOString();
    record.sessionExpiresAt = new Date(now + ttlMs).toISOString();
    record.sessionTtlMs = ttlMs;
    this.markDirty();
    return record.activeSessionId!;
  }

  /** Get public-safe status for an access key. `weeklyRatio` 用于派生周上限(5h×R)的展示;
   *  传回调(按桶解析 R)或数字;省略 → 仅在显式 weeklyTokenLimit 时有周数据。 */
  publicStatus(record: AccessKeyRecord, alignedResetAt = 0, weeklyRatio?: number | ((bucket: string) => number)): any {
    if (!record) return null;
    const now = Date.now();
    resetWindowIfExpired(record, now);
    const recentTokens = recentTokenUsage(record, now);
    const bucketUsage = recentBucketUsage(record, now);
    // Bound cards align their window to the account's upstream reset; the client
    // back-derives its local-quota window end from this, so it must match the
    // server's aligned window rather than the global fixed-period one.
    const resetMs = alignedResetAt > 0 ? Math.max(0, alignedResetAt - now) : tokenWindowResetMs(record, now);
    const expiresAt = keyExpiresAt(record);

    // Weekly window:显式 weeklyTokenLimit,或对 anthropic/codex 桶按「5h上限 × R」派生
    // (与 resolveFromRequest 的 enforce 口径一致),让池子卡也能显示「周血条」。
    resetWeeklyWindowIfExpired(record, now);
    const wkLimit = weeklyTokenLimit(record);
    const ratioForBucket = (bucket: string): number => {
      const r = typeof weeklyRatio === 'function' ? Number(weeklyRatio(bucket)) : Number(weeklyRatio);
      return Number.isFinite(r) && r > 0 ? r : DEFAULT_WEEKLY_RATIO;
    };
    const weeklyCapFor = (bucket: string): number => {
      if (wkLimit > 0) return this.billing.bucketLimit(wkLimit, bucket, record);
      const cap5h = this.billing.bucketLimit(0, bucket, record);
      const product = productOfBucket(bucket);
      if (cap5h > 0 && (product === 'anthropic' || product === 'codex')) return cap5h * ratioForBucket(bucket);
      return 0;
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
      totalRequests: Number(record.totalRequests || 0),
      totalInputTokens: Number(record.totalInputTokens || 0),
      totalOutputTokens: Number(record.totalOutputTokens || 0),
      totalCachedInputTokens: Number(record.totalCachedInputTokens || 0),
      totalRawTokensUsed: Number(record.totalRawTokensUsed || 0),
      totalTokensUsed: Number(record.totalTokensUsed || 0),
      recentWindowTokens: recentTokens.totalTokens,
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
      })),
      hasActiveSession: Boolean(
        record.activeSessionId && !isAccessKeySessionExpired(record, now),
      ),
      lastUsedAt: record.lastUsedAt || '',
      // 卡级 fair-share 份额:weight = 这张卡占的份数,shareCapacity = 号总份数(默认 8)。
      // 客户端「我的卡 · 份额」条展开显示「份额 weight/shareCapacity」。
      weight: Math.max(1, Math.floor(Number((record as any).weight) || 1)),
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
    };
  }
}
