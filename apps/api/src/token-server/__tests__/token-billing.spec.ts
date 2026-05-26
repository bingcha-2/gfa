import { describe, expect, it } from 'vitest';

import {
  readTokenCount,
  isGeminiModel,
  discountedCachedTokens,
  billableTokenUsageTotal,
  resetWindowIfExpired,
  tokenWindowMs,
  tokenWindowLimit,
  recentTokenUsage,
  tokenWindowResetMs,
  keyExpiresAt,
  accessKeySessionTtlMs,
  isAccessKeySessionExpired,
  validateClientVersion,
} from '../token-billing';

// ── Constants used in tests ──────────────────────────────────────────────────

const DEFAULT_KEY_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const DEFAULT_KEY_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── readTokenCount ───────────────────────────────────────────────────────────

describe('readTokenCount', () => {
  it('should parse positive integers', () => {
    expect(readTokenCount(100)).toBe(100);
    expect(readTokenCount(42.9)).toBe(42);
    expect(readTokenCount('500')).toBe(500);
  });

  it('should return 0 for invalid/non-positive values', () => {
    expect(readTokenCount(0)).toBe(0);
    expect(readTokenCount(-5)).toBe(0);
    expect(readTokenCount(NaN)).toBe(0);
    expect(readTokenCount(null)).toBe(0);
    expect(readTokenCount(undefined)).toBe(0);
    expect(readTokenCount('not a number')).toBe(0);
    expect(readTokenCount(Infinity)).toBe(0);
  });
});

// ── isGeminiModel ────────────────────────────────────────────────────────────

describe('isGeminiModel', () => {
  it('should detect gemini model keys', () => {
    expect(isGeminiModel('gemini-2.5-pro')).toBe(true);
    expect(isGeminiModel('gemini-flash')).toBe(true);
    expect(isGeminiModel('gem-something')).toBe(true);
    expect(isGeminiModel('GEMINI-PRO')).toBe(true);
  });

  it('should return false for non-gemini models', () => {
    expect(isGeminiModel('claude-sonnet-4-20250514')).toBe(false);
    expect(isGeminiModel('opus')).toBe(false);
    expect(isGeminiModel('')).toBe(false);
    expect(isGeminiModel(null)).toBe(false);
  });
});

// ── discountedCachedTokens ───────────────────────────────────────────────────

describe('discountedCachedTokens', () => {
  it('should return 1/10 of cached tokens (rounded up)', () => {
    expect(discountedCachedTokens(1000)).toBe(100);
    expect(discountedCachedTokens(15)).toBe(2); // ceil(15/10) = 2
    expect(discountedCachedTokens(1)).toBe(1);
  });

  it('should return 0 for zero or invalid input', () => {
    expect(discountedCachedTokens(0)).toBe(0);
    expect(discountedCachedTokens(-5)).toBe(0);
    expect(discountedCachedTokens(null)).toBe(0);
  });
});

// ── billableTokenUsageTotal ──────────────────────────────────────────────────

describe('billableTokenUsageTotal', () => {
  it('should calculate billable tokens with cache discount', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 800,
      rawTotalTokens: 1500,
    };
    // billable = max(0, 1500 - 800 + ceil(800/10)) = max(0, 700 + 80) = 780
    expect(billableTokenUsageTotal(usage, '')).toBe(780);
  });

  it('should handle usage without cache', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
    };
    // rawTotalTokens = input + output = 1500, no cache → billable = 1500
    expect(billableTokenUsageTotal(usage, '')).toBe(1500);
  });

  it('should handle empty usage', () => {
    expect(billableTokenUsageTotal({}, '')).toBe(0);
  });
});

// ── resetWindowIfExpired ─────────────────────────────────────────────────────

describe('resetWindowIfExpired', () => {
  it('should reset window when windowStartedAt is 0', () => {
    const record: any = { windowStartedAt: 0, usageEvents: [{ at: 1 }], tokenUsageEvents: [{ at: 1 }] };
    const now = Date.now();
    const result = resetWindowIfExpired(record, now);
    expect(result).toBe(true);
    expect(record.windowStartedAt).toBe(now);
    expect(record.usageEvents).toEqual([]);
    expect(record.tokenUsageEvents).toEqual([]);
  });

  it('should reset window when expired', () => {
    const now = Date.now();
    const record: any = {
      windowStartedAt: now - DEFAULT_KEY_WINDOW_MS - 1000,
      windowMs: DEFAULT_KEY_WINDOW_MS,
      usageEvents: [{ at: now - 1000 }],
      tokenUsageEvents: [],
    };
    const result = resetWindowIfExpired(record, now);
    expect(result).toBe(true);
    expect(record.windowStartedAt).toBe(now);
  });

  it('should not reset window when still active', () => {
    const now = Date.now();
    const record: any = {
      windowStartedAt: now - 1000,
      windowMs: DEFAULT_KEY_WINDOW_MS,
      usageEvents: [{ at: now }],
      tokenUsageEvents: [],
    };
    const result = resetWindowIfExpired(record, now);
    expect(result).toBe(false);
    expect(record.usageEvents).toHaveLength(1);
  });
});

// ── tokenWindowMs / tokenWindowLimit ─────────────────────────────────────────

describe('tokenWindowMs', () => {
  it('should return configured tokenWindowMs', () => {
    expect(tokenWindowMs({ tokenWindowMs: 7200000 })).toBe(7200000);
  });

  it('should fall back to windowMs', () => {
    expect(tokenWindowMs({ windowMs: 3600000 })).toBe(3600000);
  });

  it('should fall back to default', () => {
    expect(tokenWindowMs({})).toBe(DEFAULT_KEY_WINDOW_MS);
  });
});

describe('tokenWindowLimit', () => {
  it('should return explicit tokenWindowLimit', () => {
    expect(tokenWindowLimit({ tokenWindowLimit: 500000 })).toBe(500000);
  });

  it('should compute from windowLimit * tokensPerRequest', () => {
    // windowLimit=300, tokensPerRequest=100_000 → 30_000_000
    expect(tokenWindowLimit({ windowLimit: 300 })).toBe(30_000_000);
  });

  it('should return 0 when no limits set', () => {
    expect(tokenWindowLimit({})).toBe(0);
  });
});

// ── recentTokenUsage ─────────────────────────────────────────────────────────

describe('recentTokenUsage', () => {
  it('should sum token usage events within window', () => {
    const now = Date.now();
    const record: any = {
      windowStartedAt: now - 1000,
      windowMs: DEFAULT_KEY_WINDOW_MS,
      usageEvents: [],
      tokenUsageEvents: [
        { at: now, inputTokens: 100, outputTokens: 50, modelKey: 'opus' },
        { at: now, inputTokens: 200, outputTokens: 100, modelKey: 'gemini-pro' },
      ],
    };
    const result = recentTokenUsage(record, now);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
    expect(result.opusEffectiveTokens).toBeGreaterThan(0);
    expect(result.geminiEffectiveTokens).toBeGreaterThan(0);
  });

  it('should return zeros for empty events', () => {
    const now = Date.now();
    const record: any = {
      windowStartedAt: now,
      windowMs: DEFAULT_KEY_WINDOW_MS,
      usageEvents: [],
      tokenUsageEvents: [],
    };
    const result = recentTokenUsage(record, now);
    expect(result.totalTokens).toBe(0);
  });
});

// ── tokenWindowResetMs ───────────────────────────────────────────────────────

describe('tokenWindowResetMs', () => {
  it('should return remaining time in window', () => {
    const now = Date.now();
    const record: any = {
      windowStartedAt: now - 1000,
      windowMs: DEFAULT_KEY_WINDOW_MS,
      usageEvents: [],
      tokenUsageEvents: [],
    };
    const result = tokenWindowResetMs(record, now);
    expect(result).toBeGreaterThan(DEFAULT_KEY_WINDOW_MS - 2000);
    expect(result).toBeLessThanOrEqual(DEFAULT_KEY_WINDOW_MS);
  });

  it('should return 0 when no window started', () => {
    const record: any = { windowStartedAt: 0, usageEvents: [], tokenUsageEvents: [] };
    // resetWindowIfExpired will set a new window, then remaining is full window
    const result = tokenWindowResetMs(record, Date.now());
    expect(result).toBeGreaterThan(0);
  });
});

// ── keyExpiresAt ─────────────────────────────────────────────────────────────

describe('keyExpiresAt', () => {
  it('should compute expiration from firstUsedAt + durationMs', () => {
    const record = {
      firstUsedAt: '2025-01-01T00:00:00.000Z',
      durationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    };
    const result = keyExpiresAt(record);
    expect(result).toBe('2025-01-31T00:00:00.000Z');
  });

  it('should return empty string when no firstUsedAt', () => {
    expect(keyExpiresAt({})).toBe('');
    expect(keyExpiresAt({ durationMs: 1000 })).toBe('');
  });

  it('should return empty string when no durationMs', () => {
    expect(keyExpiresAt({ firstUsedAt: '2025-01-01T00:00:00.000Z' })).toBe('');
  });
});

// ── accessKeySessionTtlMs ────────────────────────────────────────────────────

describe('accessKeySessionTtlMs', () => {
  it('should return configured TTL', () => {
    expect(accessKeySessionTtlMs({ sessionTtlMs: 30000 })).toBe(30000);
  });

  it('should fall back to default', () => {
    expect(accessKeySessionTtlMs({})).toBe(DEFAULT_KEY_SESSION_TTL_MS);
  });
});

// ── isAccessKeySessionExpired ────────────────────────────────────────────────

describe('isAccessKeySessionExpired', () => {
  it('should return true when no sessionExpiresAt', () => {
    expect(isAccessKeySessionExpired({})).toBe(true);
  });

  it('should return true when session has expired', () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    expect(isAccessKeySessionExpired({ sessionExpiresAt: pastDate })).toBe(true);
  });

  it('should return false when session is still active', () => {
    const futureDate = new Date(Date.now() + 60000).toISOString();
    expect(isAccessKeySessionExpired({ sessionExpiresAt: futureDate })).toBe(false);
  });
});

// ── validateClientVersion ────────────────────────────────────────────────────

describe('validateClientVersion', () => {
  it('should pass for sufficient version', () => {
    const result = validateClientVersion({ clientVersion: '5.0.0' }, '4.0.6');
    expect(result.ok).toBe(true);
  });

  it('should pass for exact minimum version', () => {
    const result = validateClientVersion({ clientVersion: '4.0.6' }, '4.0.6');
    expect(result.ok).toBe(true);
  });

  it('should fail for old version', () => {
    const result = validateClientVersion({ clientVersion: '3.0.0' }, '4.0.6');
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(426);
  });

  it('should fail with 401 when no version provided', () => {
    const result = validateClientVersion({}, '4.0.6');
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('should pass when no minimum version configured', () => {
    const result = validateClientVersion({}, '');
    expect(result.ok).toBe(true);
  });
});
