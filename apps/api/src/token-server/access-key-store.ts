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
  tokenWindowLimit,
  recentTokenUsage,
  tokenWindowResetMs,
  tokenWindowMs as getTokenWindowMs,
  keyExpiresAt,
  accessKeySessionTtlMs,
  isAccessKeySessionExpired,
  isGeminiModel,
  DEFAULT_KEY_WINDOW_MS,
  DEFAULT_KEY_SESSION_TTL_MS,
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

const SAVE_DEBOUNCE_MS = 3000;

export class AccessKeyStore {
  private cache: AccessKeysData | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath: string) {}

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
    const recentTokens = recentTokenUsage(record, now);

    if (options.enforceLimit && baseLimit > 0) {
      const modelKeyStr = String(options.modelKey || '').trim();
      const isGemini = isGeminiModel(modelKeyStr);
      const geminiLimit = baseLimit * 5;
      const opusLimit = baseLimit;

      if (modelKeyStr) {
        if (isGemini && recentTokens.geminiEffectiveTokens >= geminiLimit) {
          this.writeCache();
          return {
            key: keyValue, record: null,
            error: `Access key Gemini token limit exceeded (${recentTokens.geminiEffectiveTokens}/${geminiLimit} tokens/5h)`,
          };
        }
        if (!isGemini && recentTokens.opusEffectiveTokens >= opusLimit) {
          this.writeCache();
          return {
            key: keyValue, record: null,
            error: `Access key Opus token limit exceeded (${recentTokens.opusEffectiveTokens}/${opusLimit} tokens/5h)`,
          };
        }
      } else if (
        recentTokens.opusEffectiveTokens >= opusLimit &&
        recentTokens.geminiEffectiveTokens >= geminiLimit
      ) {
        this.writeCache();
        return {
          key: keyValue, record: null,
          error: `Access key token limit exceeded`,
        };
      }
    }

    if (options.activate) this.writeCache();
    return { key: keyValue, record, data };
  }

  // ── Usage recording ────────────────────────────────────────────────────

  recordUsage(cardId: string, status: number, usage: any = {}, modelKey = ''): void {
    if (!cardId) return;
    const record = this.findById(cardId);
    if (!record) return;

    const now = Date.now();
    resetWindowIfExpired(record, now);

    const inputTokens = readTokenCount(usage.inputTokens);
    const outputTokens = readTokenCount(usage.outputTokens);
    const cachedInputTokens = readTokenCount(usage.cachedInputTokens);
    const rawTotalTokens = readTokenCount(usage.rawTotalTokens) || inputTokens + outputTokens;
    const totalTokens = billableTokenUsageTotal(
      { ...usage, inputTokens, outputTokens, cachedInputTokens, rawTotalTokens },
      modelKey,
    );

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
    const tLimit = tokenWindowLimit(record);
    const resetMs = tokenWindowResetMs(record, now);
    const expiresAt = keyExpiresAt(record);

    return {
      id: record.id,
      name: record.name || '',
      status: record.status || 'active',
      firstUsedAt: record.firstUsedAt || '',
      expiresAt,
      remainingMs: expiresAt ? Math.max(0, Date.parse(expiresAt) - now) : 0,
      totalRequests: Number(record.totalRequests || 0),
      totalTokensUsed: Number(record.totalTokensUsed || 0),
      recentWindowTokens: recentTokens.totalTokens,
      tokenWindowLimit: tLimit,
      tokenWindowRemaining: tLimit > 0 ? Math.max(0, tLimit - recentTokens.totalTokens) : 0,
      tokenWindowResetMs: resetMs,
      hasActiveSession: Boolean(
        record.activeSessionId && !isAccessKeySessionExpired(record, now),
      ),
      lastUsedAt: record.lastUsedAt || '',
    };
  }
}
