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
  resetWindowIfExpired,
  tokenWindowMs,
  tokenWindowLimit,
  recentTokenUsage,
  recentBucketUsage,
  tokenWindowResetMs,
  UNIVERSAL_BILLING,
  ProviderBilling,
  keyExpiresAt,
  accessKeySessionTtlMs,
  isAccessKeySessionExpired,
  ACCESS_KEY_BINDING_GRACE_MS,
} from './token-billing';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccessKeyRecord {
  id: string;
  key: string;
  name?: string;
  status?: string;
  firstUsedAt?: string;
  durationMs?: number;
  windowMs?: number;
  windowLimit?: number;
  tokenWindowLimit?: number;
  windowStartedAt?: number;
  usageEvents?: any[];
  tokenUsageEvents?: any[];
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
    }
    return this.cache;
  }

  /** Reload cache from disk (e.g., after external changes). */
  reload(): void {
    this.cache = null;
    this.readAll();
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
      }
      writeJsonFile(this.filePath, this.cache);
    } catch (err: any) {
      this.dirty = true;
      console.error(`[access-key-store] flush failed: ${err.message}`);
    }
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  findById(cardId: string): AccessKeyRecord | null {
    if (!cardId) return null;
    return this.readAll().keys.find((k) => k.id === cardId) || null;
  }

  findByKey(keyValue: string): AccessKeyRecord | null {
    if (!keyValue) return null;
    return this.readAll().keys.find((k) => constantTimeEqual(k.key, keyValue)) || null;
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
    options: { activate?: boolean; enforceLimit?: boolean; modelKey?: string } = {},
  ): ResolveResult {
    const keyValue = AccessKeyStore.extractKeyFromRequest(req, payload);
    if (!keyValue) return { key: keyValue, record: null, error: 'Missing access key' };

    const data = this.readAll();
    const record = data.keys.find((k) => constantTimeEqual(k.key, keyValue));
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

    resetWindowIfExpired(record, now);
    const baseLimit = tokenWindowLimit(record);

    if (options.enforceLimit && baseLimit > 0) {
      const modelKeyStr = String(options.modelKey || '').trim();
      const bucketUsage = recentBucketUsage(record, this.billing.bucketOf, now);

      if (modelKeyStr) {
        const bucket = this.billing.bucketOf(modelKeyStr);
        const used = bucketUsage.get(bucket) || 0;
        const limit = this.billing.bucketLimit(baseLimit, bucket);
        if (limit > 0 && used >= limit) {
          this.writeCache();
          return {
            key: keyValue, record: null,
            error: `Access key ${this.billing.bucketLabel(bucket)} token limit exceeded (${used}/${limit} tokens/5h)`,
          };
        }
      } else {
        // No modelKey → reject when every bucket the card has ACTUALLY used is
        // exhausted. Buckets with zero usage are excluded: otherwise a bucket the
        // card never serves (e.g. codex on an antigravity-only card) has usage 0 <
        // limit forever, so `every` is never true and an exhausted card is never
        // rejected. Filtering to used buckets restores the original intent
        // (reject when out of budget across the buckets in play).
        const usedBuckets = this.billing.buckets.filter((b) => (bucketUsage.get(b) || 0) > 0);
        const allExhausted =
          usedBuckets.length > 0 &&
          usedBuckets.every((b) => (bucketUsage.get(b) || 0) >= this.billing.bucketLimit(baseLimit, b));
        if (allExhausted) {
          this.writeCache();
          return {
            key: keyValue, record: null,
            error: `Access key token limit exceeded`,
          };
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
  computeUsageDetail(usage: any = {}, modelKey = '') {
    const inputTokens = readTokenCount(usage.inputTokens);
    const outputTokens = readTokenCount(usage.outputTokens);
    const cachedInputTokens = readTokenCount(usage.cachedInputTokens);
    const rawTotalTokens = readTokenCount(usage.rawTotalTokens) || inputTokens + outputTokens;
    const totalTokens = billableTokenUsageTotal(
      { ...usage, inputTokens, outputTokens, cachedInputTokens, rawTotalTokens },
      modelKey,
    );
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      rawTotalTokens,
      totalTokens,
      bucket: this.billing.bucketOf(modelKey || ''),
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
  recordUsage(cardId: string, status: number, usage: any = {}, modelKey = '', reportId = ''): boolean {
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
      this.computeUsageDetail(usage, modelKey);

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
        rawTotalTokens, totalTokens, modelKey: modelKey || '',
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
    const ttlMs = accessKeySessionTtlMs(record);
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

  /** Get public-safe status for an access key. */
  publicStatus(record: AccessKeyRecord): any {
    if (!record) return null;
    const now = Date.now();
    resetWindowIfExpired(record, now);
    const recentTokens = recentTokenUsage(record, now);
    const bucketUsage = recentBucketUsage(record, this.billing.bucketOf, now);
    const tLimit = tokenWindowLimit(record);
    const resetMs = tokenWindowResetMs(record, now);
    const expiresAt = keyExpiresAt(record);

    const windowLimit = Number(record.windowLimit || 0);

    // Products the card is sold for (bindings keys with a real account id).
    // Empty = pool card. Lets the client show only the relevant usage bars.
    const products = record.bindings && typeof record.bindings === 'object'
      ? Object.keys(record.bindings).filter((p) => Number((record.bindings as Record<string, number>)[p]) > 0)
      : [];

    return {
      id: record.id,
      name: record.name || '',
      status: record.status || 'active',
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
      // Legacy gemini/opus fields (antigravity client contract). Derived from the
      // bucket map so a non-gemini/opus provider (codex) reports 0 here and its
      // usage shows under its own bucket in `buckets` below.
      opusTokensUsed: bucketUsage.get('opus') || 0,
      opusTokenLimit: tLimit > 0 ? tLimit : (windowLimit > 0 ? windowLimit * 100_000 : 0),
      geminiTokensUsed: bucketUsage.get('gemini') || 0,
      geminiTokenLimit: tLimit > 0 ? tLimit * 5 : (windowLimit > 0 ? windowLimit * 500_000 : 0),
      // Codex flat fields (mirror opus/gemini) so the client can show a codex bar.
      codexTokensUsed: bucketUsage.get('codex') || 0,
      codexTokenLimit: this.billing.bucketLimit(tLimit, 'codex'),
      // Provider-correct per-bucket view (gemini/opus for antigravity, codex for codex).
      buckets: this.billing.buckets.map((bucket) => ({
        bucket,
        used: bucketUsage.get(bucket) || 0,
        limit: this.billing.bucketLimit(tLimit, bucket),
      })),
      tokenWindowLimit: tLimit,
      tokenWindowMs: tokenWindowMs(record),
      tokenWindowRemaining: tLimit > 0 ? Math.max(0, tLimit - recentTokens.totalTokens) : 0,
      tokenWindowResetMs: resetMs,
      tokenWindowResetAt: resetMs > 0 ? new Date(now + resetMs).toISOString() : '',
      hasActiveSession: Boolean(
        record.activeSessionId && !isAccessKeySessionExpired(record, now),
      ),
      lastUsedAt: record.lastUsedAt || '',
    };
  }
}
