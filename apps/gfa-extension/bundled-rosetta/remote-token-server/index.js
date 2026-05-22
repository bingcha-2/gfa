#!/usr/bin/env node
'use strict';

/**
 * Remote Token Server
 *
 * Runs on the account-owner machine. It reuses the same accounts.json and
 * token-manager as the local Token Proxy, but only leases short-lived Google
 * access tokens plus project IDs to trusted relay clients.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const paths = require('../shared/paths');
const { createLogger } = require('../shared/logger');
const { createTokenManager } = require('../token-proxy/token-manager');
const { createQuotaTracker } = require('../token-proxy/quota-tracker');

paths.ensureDataDir();

const ACCESS_KEY_BACKUP_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_ACCESS_KEY_BACKUP_INTERVAL_MS || 60 * 60 * 1000),
);

function shouldBackupAccessKeys(filePath) {
  if (!fs.existsSync(filePath) || path.basename(filePath) !== 'access-keys.json') {
    return false;
  }
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.bak-`;
  const now = Date.now();
  try {
    const hasRecentBackup = fs.readdirSync(dir).some((name) => {
      if (!name.startsWith(prefix)) return false;
      try {
        const stat = fs.statSync(path.join(dir, name));
        return now - stat.mtimeMs < ACCESS_KEY_BACKUP_INTERVAL_MS;
      } catch (_) {
        return false;
      }
    });
    return !hasRecentBackup;
  } catch (_) {
    return true;
  }
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (error) {
    if (path.basename(filePath) === 'access-keys.json') {
      throw new Error(`Failed to parse ${path.basename(filePath)}: ${error.message || error}`);
    }
    return {};
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (shouldBackupAccessKeys(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(filePath, `${filePath}.bak-${stamp}`);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.setTimeout(30000, () => reject(new Error('Request body timeout')));
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token-Server-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at <= 1) return value ? '***' : '';
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}

function isVerificationChallengeText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('please verify your account') ||
    text.includes('verify your account to continue') ||
    text.includes('verify account') ||
    text.includes('verify your info to continue') ||
    text.includes('google needs to verify') ||
    text.includes('verify some info about your device or phone number') ||
    text.includes('scan the qr code with your phone') ||
    text.includes('account to continue using antigravity') ||
    text.includes('validation_required') ||
    text.includes('"reason":"validation_required"') ||
    text.includes('"reason": "validation_required"') ||
    text.includes('validation_url') ||
    text.includes('validation_error_message') ||
    text.includes('permission_denied') ||
    text.includes('al_alert')
  );
}

function isLocationUnsupportedText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('user location is not supported') ||
    text.includes('location is not supported for the api use') ||
    (text.includes('failed_precondition') && text.includes('location') && text.includes('not supported'))
  );
}

function isPermanentTokenRefreshError(value) {
  const text = String(value || '').toLowerCase();
  return (
    text.includes('invalid_grant') ||
    text.includes('token has been expired or revoked') ||
    (text.includes('error_description') && text.includes('bad request')) ||
    text.includes('access_denied') ||
    text.includes('account restricted') ||
    text.includes('servicerestricted')
  );
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isAuthorized(req, payload, secret) {
  return Boolean(resolveAccessKey(req, payload).record);
}

const DEFAULT_LEASE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_AFFINITY_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 1;
const DEFAULT_KEY_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_KEY_WINDOW_LIMIT = 300;
const DEFAULT_KEY_TOKENS_PER_REQUEST = Math.max(
  1000,
  Number(process.env.BCAI_DEFAULT_KEY_TOKENS_PER_REQUEST || 100_000)
);
const DEFAULT_KEY_SESSION_TTL_MS = 10 * 60 * 1000;
const ACCESS_KEY_BINDING_GRACE_MS = Math.max(
  1000,
  Number(process.env.BCAI_ACCESS_KEY_BINDING_GRACE_MS || 15_000)
);
const MAX_REMOTE_LEASE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_MAX_REMOTE_LEASE_TTL_MS || 5 * 60 * 1000)
);
const PHONE_VERIFICATION_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.BCAI_PHONE_VERIFICATION_COOLDOWN_MS || 24 * 60 * 60 * 1000)
);
const FIRST_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const SECOND_QUOTA_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MAX_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const CAPACITY_COOLDOWN_MS = 15 * 1000;
const MAX_CAPACITY_COOLDOWN_MS = 2 * 60 * 1000;
const REMOTE_ACCOUNT_ERROR_THRESHOLD = Math.max(
  1,
  Number(process.env.BCAI_REMOTE_ACCOUNT_ERROR_THRESHOLD || 3)
);
const REMOTE_TRANSIENT_ERROR_COOLDOWN_MS = Math.max(
  5 * 1000,
  Number(process.env.BCAI_REMOTE_TRANSIENT_ERROR_COOLDOWN_MS || 30 * 1000)
);
const REMOTE_RECHECK_COOLDOWN_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_REMOTE_RECHECK_COOLDOWN_MS || 5 * 60 * 1000)
);
const LOCATION_UNSUPPORTED_COOLDOWN_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_LOCATION_UNSUPPORTED_COOLDOWN_MS || 5 * 60 * 1000)
);
const LOCATION_UNSUPPORTED_MAX_FAILURES = Number(process.env.BCAI_LOCATION_UNSUPPORTED_MAX_FAILURES || 20);
const MODEL_PRESSURE_BASE_MS = 20 * 1000;
const MODEL_PRESSURE_MAX_MS = 30 * 1000;
const MODEL_PRESSURE_UNIQUE_THRESHOLD = 8;
const MODEL_PRESSURE_WINDOW_MS = 60 * 1000;
const PROBATION_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_RECHECK_AFTER_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_AUTO_RECHECK_AFTER_MS || 5 * 60 * 1000)
);
const AUTO_RECHECK_SWEEP_MS = Math.max(
  30 * 1000,
  Number(process.env.BCAI_AUTO_RECHECK_SWEEP_MS || 60 * 1000)
);
const AUTO_RECHECK_VERIFY_LIMIT = Math.max(
  1,
  Number(process.env.BCAI_AUTO_RECHECK_VERIFY_LIMIT || 20)
);
const MIN_HEALTHY_CANDIDATES = 2;
const AUTH_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RECENT_SUCCESS_GRACE_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_RECENT_SUCCESS_GRACE_MS || 10 * 60 * 1000)
);
const VERIFICATION_FAILURES_BEFORE_QUARANTINE = Math.max(
  1,
  Number(process.env.BCAI_VERIFICATION_FAILURES_BEFORE_QUARANTINE || 2)
);
const MIN_CLIENT_VERSION = String(process.env.BCAI_MIN_CLIENT_VERSION || '4.0.6').trim();
const CLIENT_UPGRADE_URL = String(process.env.BCAI_CLIENT_UPGRADE_URL || 'https://bcai.site/add-account.html').trim();
const ACCESS_KEYS_PATH = path.join(paths.DATA_DIR, 'access-keys.json');
const INTEGRITY_HASHES_PATH = path.join(paths.DATA_DIR, 'integrity-hashes.json');

// ── Client integrity hash verification ───────────────────────────────────────
// Maintains a whitelist of known-good SHA-256 hashes of token-proxy.js.
// When a client reports an unknown hash, the access key is flagged.
function readIntegrityHashes() {
  try {
    const data = JSON.parse(fs.readFileSync(INTEGRITY_HASHES_PATH, 'utf8'));
    return Array.isArray(data.hashes) ? data.hashes : [];
  } catch {
    return [];
  }
}

function addIntegrityHash(hash) {
  const hashes = readIntegrityHashes();
  if (!hashes.includes(hash)) {
    hashes.push(hash);
    try {
      fs.writeFileSync(INTEGRITY_HASHES_PATH, JSON.stringify({ hashes, updatedAt: new Date().toISOString() }, null, 2));
    } catch {}
  }
}

function verifyIntegrityHash(hash, accessKeyId, log) {
  if (!hash || hash === 'unknown') return; // Old client without integrity support
  const known = readIntegrityHashes();
  if (known.length === 0) {
    // First time: auto-register this hash as trusted
    addIntegrityHash(hash);
    log(`[remote-token] integrity: auto-registered first known hash ${hash.substring(0, 16)}...`);
    return;
  }
  if (known.includes(hash)) return; // Known good hash
  // Unknown hash — flag the access key
  const record = findAccessKeyRecord(accessKeyId);
  if (record) {
    if (!record._integrityWarnings) record._integrityWarnings = 0;
    record._integrityWarnings++;
    record._lastIntegrityHash = hash;
    record._lastIntegrityWarningAt = new Date().toISOString();
  }
  log(
    `[remote-token] ⚠ INTEGRITY MISMATCH: key=${accessKeyId} hash=${hash.substring(0, 16)}... ` +
    `does not match any of ${known.length} known hashes. Client code may be tampered!`
  );
}

function parseVersionParts(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const match = String(part || '').match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });
}

function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function validateClientVersion(payload) {
  if (!MIN_CLIENT_VERSION) return { ok: true };
  const clientVersion = String(payload?.clientVersion || payload?.version || '').trim();
  if (!clientVersion || compareVersions(clientVersion, MIN_CLIENT_VERSION) < 0) {
    const missingClientVersion = !clientVersion;
    return {
      ok: false,
      // Old 3.x clients did not send clientVersion and may not surface HTTP 426
      // clearly. Use 401 for those clients so their existing auth-error UI path
      // shows the upgrade text, while explicit-but-old versions still get 426.
      statusCode: missingClientVersion ? 401 : 426,
      missingClientVersion,
      clientVersion,
      minClientVersion: MIN_CLIENT_VERSION,
      upgradeUrl: CLIENT_UPGRADE_URL,
    };
  }
  return { ok: true, clientVersion };
}

function emptyAccessKeys() {
  return { keys: [], updatedAt: '' };
}

function readAccessKeys() {
  const parsed = readJsonFile(ACCESS_KEYS_PATH);
  return { keys: Array.isArray(parsed.keys) ? parsed.keys : [], updatedAt: parsed.updatedAt || '' };
}

function writeAccessKeys(data) {
  writeJsonFile(ACCESS_KEYS_PATH, {
    keys: Array.isArray(data.keys) ? data.keys : [],
    updatedAt: new Date().toISOString(),
  });
}

function findAccessKeyRecord(cardId) {
  if (!cardId) return null;
  const data = readAccessKeys();
  return data.keys.find((item) => item.id === cardId) || null;
}

function accessKeyFromRequest(req, payload) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  return String(
    req.headers['x-token-server-secret'] ||
    req.headers['x-access-key'] ||
    payload?.accessKey ||
    payload?.cardKey ||
    payload?.key ||
    bearer ||
    ''
  ).trim();
}

function normalizeSessionId(value) {
  return String(value || '').trim();
}

function makeSessionId() {
  return `sess_${Date.now().toString(36)}_${crypto.randomBytes(12).toString('hex')}`;
}

function keyExpiresAt(record) {
  if (!record?.firstUsedAt) return '';
  const durationMs = Number(record.durationMs || 0);
  if (!durationMs) return '';
  return new Date(Date.parse(record.firstUsedAt) + durationMs).toISOString();
}

/**
 * Fixed-period window reset: if the current window has expired, clear all
 * usage events and start a new window.  Unlike the old sliding-window
 * approach, this gives every key a hard "next reset" timestamp.
 */
function resetWindowIfExpired(record, now = Date.now()) {
  const windowMs = Number(record.windowMs || DEFAULT_KEY_WINDOW_MS);
  const startedAt = Number(record.windowStartedAt || 0);
  if (startedAt === 0 || (now - startedAt) >= windowMs) {
    record.windowStartedAt = now;
    record.usageEvents = [];
    record.tokenUsageEvents = [];
    return true;           // window was reset
  }
  return false;            // still inside the current window
}

function pruneUsageEvents(record, now = Date.now()) {
  resetWindowIfExpired(record, now);
}

function tokenWindowMs(record) {
  const configured = Number(record?.tokenWindowMs || 0);
  return configured > 0 ? configured : Number(record?.windowMs || DEFAULT_KEY_WINDOW_MS);
}

function tokenWindowLimit(record) {
  const explicit = Number(
    record?.tokenWindowLimit ??
    record?.windowTokenLimit ??
    record?.tokenLimit ??
    0
  );
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const requestLimit = Number(record?.windowLimit || 0);
  return requestLimit > 0 ? Math.floor(requestLimit * DEFAULT_KEY_TOKENS_PER_REQUEST) : 0;
}

function readTokenCount(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function usageTotalTokens(item) {
  const inputTokens = readTokenCount(item?.inputTokens);
  const outputTokens = readTokenCount(item?.outputTokens);
  return readTokenCount(item?.totalTokens) || inputTokens + outputTokens;
}

function usageCachedInputTokens(item) {
  return readTokenCount(item?.cachedInputTokens) || readTokenCount(item?.cachedTokens);
}

function usageRawTotalTokens(item) {
  return readTokenCount(item?.rawTotalTokens) || usageTotalTokens(item);
}

function discountedCachedTokens(cachedTokens) {
  const count = readTokenCount(cachedTokens);
  return count > 0 ? Math.ceil(count / 10) : 0;
}

// ── Model-based billing discount ─────────────────────────────────────────────
// We use independent limits for Opus and Gemini, so we no longer apply a 1/5
// multiplier to Gemini billable tokens. Both use multiplier 1.0, but have different
// quota ceilings (Opus: 100k/req, Gemini: 500k/req).
function isGeminiModel(modelKey) {
  const key = String(modelKey || '').toLowerCase();
  return key.includes('gemini') || key.startsWith('gem');
}

function modelBillingMultiplier(modelKey) {
  return 1.0;
}

function billableTokenUsageTotal(usage = {}, modelKey = '') {
  const inputTokens = readTokenCount(usage.inputTokens);
  const outputTokens = readTokenCount(usage.outputTokens);
  const cachedInputTokens = Math.min(
    inputTokens || Number.MAX_SAFE_INTEGER,
    readTokenCount(usage.cachedInputTokens) || readTokenCount(usage.cachedTokens)
  );
  const rawTotalTokens = readTokenCount(usage.rawTotalTokens) ||
    readTokenCount(usage.totalTokenCount) ||
    inputTokens + outputTokens;
  const reportedTotalTokens = readTokenCount(usage.totalTokens);
  let billable;
  if (rawTotalTokens > 0 && cachedInputTokens > 0) {
    billable = Math.max(0, rawTotalTokens - cachedInputTokens + discountedCachedTokens(cachedInputTokens));
  } else {
    billable = rawTotalTokens || reportedTotalTokens || inputTokens + outputTokens;
  }
  // Apply model discount
  const multiplier = modelBillingMultiplier(modelKey);
  if (multiplier < 1.0 && billable > 0) {
    return Math.ceil(billable * multiplier);
  }
  return billable;
}

function pruneTokenUsageEvents(record, now = Date.now()) {
  resetWindowIfExpired(record, now);
}

function recentTokenUsage(record, now = Date.now()) {
  pruneTokenUsageEvents(record, now);
  return (record.tokenUsageEvents || []).reduce((total, item) => {
    const rawTotal = usageRawTotalTokens(item);
    const billable = billableTokenUsageTotal(item, item.modelKey);

    total.inputTokens += readTokenCount(item?.inputTokens);
    total.outputTokens += readTokenCount(item?.outputTokens);
    total.cachedInputTokens += usageCachedInputTokens(item);
    total.rawTotalTokens += rawTotal;
    total.totalTokens += billable;
    
    // Track Opus and Gemini effective tokens separately
    if (isGeminiModel(item?.modelKey)) {
      total.geminiRawTokens += rawTotal;
      total.geminiEffectiveTokens += billable;
    } else {
      total.opusRawTokens += rawTotal;
      total.opusEffectiveTokens += billable;
    }
    return total;
  }, { 
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, 
    rawTotalTokens: 0, totalTokens: 0, 
    geminiRawTokens: 0, geminiEffectiveTokens: 0,
    opusRawTokens: 0, opusEffectiveTokens: 0 
  });
}

function tokenWindowResetMs(record, now = Date.now()) {
  resetWindowIfExpired(record, now);
  const startedAt = Number(record.windowStartedAt || 0);
  if (startedAt <= 0) return 0;
  const windowMs = Number(record.windowMs || DEFAULT_KEY_WINDOW_MS);
  return Math.max(0, startedAt + windowMs - now);
}

function accessKeySessionTtlMs(record) {
  const configured = Number(record?.sessionTtlMs || 0);
  return configured > 0 ? configured : DEFAULT_KEY_SESSION_TTL_MS;
}

function isAccessKeySessionExpired(record, now = Date.now()) {
  const expiresAt = Date.parse(record?.sessionExpiresAt || '');
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function refreshAccessKeySession(record, payload, now = Date.now(), options = {}) {
  const ttlMs = accessKeySessionTtlMs(record);
  const clientId = String(payload?.clientId || payload?.client || '').trim();
  const hasLiveSession = normalizeSessionId(record.activeSessionId) && !isAccessKeySessionExpired(record, now);
  const shouldCreate = Boolean(options.create) || !hasLiveSession;
  const shouldRotate = Boolean(options.rotate);
  if (shouldCreate || shouldRotate) {
    record.activeSessionId = makeSessionId();
    record.sessionStartedAt = new Date(now).toISOString();
    record.sessionClientId = clientId;
  } else {
    record.activeSessionId = normalizeSessionId(record.activeSessionId) || makeSessionId();
    if (!record.sessionClientId && clientId) {
      record.sessionClientId = clientId;
    }
    record.sessionStartedAt = record.sessionStartedAt || new Date(now).toISOString();
  }
  record.sessionLastSeenAt = new Date(now).toISOString();
  record.sessionExpiresAt = new Date(now + ttlMs).toISOString();
  record.sessionTtlMs = ttlMs;
  return record.activeSessionId;
}

function validateAccessKeySession(record, payload, now = Date.now()) {
  const requestedSessionId = normalizeSessionId(
    payload?.sessionId ||
    payload?.accessKeySessionId ||
    payload?.relayProxySessionId
  );
  const requestedClientId = String(payload?.clientId || payload?.client || '').trim();
  const activeSessionId = normalizeSessionId(record.activeSessionId);
  if (!activeSessionId || isAccessKeySessionExpired(record, now)) {
    return { ok: true, action: 'create', requestedSessionId };
  }
  if (requestedSessionId && constantTimeEqual(requestedSessionId, activeSessionId)) {
    const activeClientId = String(record.sessionClientId || '').trim();
    if (!requestedClientId) {
      return {
        ok: false,
        error: 'Access key session requires client identity',
        statusCode: 409,
        sessionClientId: activeClientId,
        sessionExpiresAt: record.sessionExpiresAt || '',
      };
    }
    if (activeClientId && requestedClientId !== activeClientId) {
      return {
        ok: false,
        error: 'Access key session belongs to another client',
        statusCode: 409,
        sessionClientId: activeClientId,
        sessionExpiresAt: record.sessionExpiresAt || '',
      };
    }
    return { ok: true, action: 'refresh', requestedSessionId };
  }
  const activeClientId = String(record.sessionClientId || '').trim();
  if (requestedClientId && activeClientId && requestedClientId === activeClientId) {
    return {
      ok: true,
      action: 'reuse',
      requestedSessionId,
      sameClientSessionReuse: true,
    };
  }
  const sessionStartedAt = Date.parse(record.sessionStartedAt || '');
  const withinInitialBindingGrace = Number.isFinite(sessionStartedAt) &&
    now - sessionStartedAt >= 0 &&
    now - sessionStartedAt <= ACCESS_KEY_BINDING_GRACE_MS;
  if (!requestedSessionId && requestedClientId && activeClientId && requestedClientId === activeClientId && withinInitialBindingGrace) {
    return {
      ok: true,
      action: 'reuse',
      requestedSessionId,
      sameClientGrace: true,
    };
  }
  return {
    ok: false,
    error: 'Access key is already active on another device',
    statusCode: 409,
    sessionClientId: record.sessionClientId || '',
    sessionExpiresAt: record.sessionExpiresAt || '',
  };
}

function resolveAccessKey(req, payload, options = {}) {
  const key = accessKeyFromRequest(req, payload);
  if (!key) return { key, record: null, error: 'Missing access key' };
  const data = readAccessKeys();
  const record = data.keys.find((item) => constantTimeEqual(item.key, key));
  if (!record) return { key, record: null, error: 'Invalid access key' };
  if (record.status && record.status !== 'active') return { key, record: null, error: 'Access key disabled' };

  const now = Date.now();
  if (!record.firstUsedAt && options.activate) {
    record.firstUsedAt = new Date(now).toISOString();
  }
  const expiresAt = keyExpiresAt(record);
  if (expiresAt && Date.parse(expiresAt) <= now) {
    record.status = 'expired';
    writeAccessKeys(data);
    return { key, record: null, error: 'Access key expired' };
  }

  pruneUsageEvents(record, now);
  const baseLimit = tokenWindowLimit(record);
  const recentTokens = recentTokenUsage(record, now);
  if (options.enforceLimit && baseLimit > 0) {
    const modelKeyStr = String(options.modelKey || '').trim();
    const isGemini = isGeminiModel(modelKeyStr);
    const geminiLimit = baseLimit * 5;
    const opusLimit = baseLimit;

    if (modelKeyStr) {
      // Known model — check only the matching pool
      if (isGemini && recentTokens.geminiEffectiveTokens >= geminiLimit) {
        writeAccessKeys(data);
        return {
          key,
          record: null,
          error: `Access key Gemini token limit exceeded (${recentTokens.geminiEffectiveTokens}/${geminiLimit} tokens/5h)`,
        };
      } else if (!isGemini && recentTokens.opusEffectiveTokens >= opusLimit) {
        writeAccessKeys(data);
        return {
          key,
          record: null,
          error: `Access key Opus token limit exceeded (${recentTokens.opusEffectiveTokens}/${opusLimit} tokens/5h)`,
        };
      }
    } else {
      // Unknown model — only block if BOTH pools are exhausted
      if (recentTokens.opusEffectiveTokens >= opusLimit && recentTokens.geminiEffectiveTokens >= geminiLimit) {
        writeAccessKeys(data);
        return {
          key,
          record: null,
          error: `Access key token limit exceeded (opus=${recentTokens.opusEffectiveTokens}/${opusLimit}, gemini=${recentTokens.geminiEffectiveTokens}/${geminiLimit} tokens/5h)`,
        };
      }
    }
  }
  if (options.activate) writeAccessKeys(data);
  return { key, record, data };
}

function recordAccessKeyUsage(cardId, status, usage = {}, modelKey = '') {
  if (!cardId) return;
  const data = readAccessKeys();
  const record = data.keys.find((item) => item.id === cardId);
  if (!record) return;
  const now = Date.now();
  pruneUsageEvents(record, now);
  pruneTokenUsageEvents(record, now);
  const inputTokens = readTokenCount(usage.inputTokens);
  const outputTokens = readTokenCount(usage.outputTokens);
  const cachedInputTokens = readTokenCount(usage.cachedInputTokens);
  const rawTotalTokens = readTokenCount(usage.rawTotalTokens) || inputTokens + outputTokens;
  const totalTokens = billableTokenUsageTotal({
    ...usage,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    rawTotalTokens,
  }, modelKey);
  record.totalRequests = Number(record.totalRequests || 0) + 1;
  record.totalInputTokens = Number(record.totalInputTokens || 0) + inputTokens;
  record.totalOutputTokens = Number(record.totalOutputTokens || 0) + outputTokens;
  record.totalCachedInputTokens = Number(record.totalCachedInputTokens || 0) + cachedInputTokens;
  record.totalRawTokensUsed = Number(record.totalRawTokensUsed || 0) + rawTotalTokens;
  record.totalTokensUsed = Number(record.totalTokensUsed || 0) + totalTokens;
  record.lastUsedAt = new Date(now).toISOString();
  record.usageEvents.push({ at: now, status: Number(status || 0) });
  if (totalTokens > 0) {
    record.tokenUsageEvents.push({
      at: now,
      status: Number(status || 0),
      inputTokens,
      outputTokens,
      cachedInputTokens,
      rawTotalTokens,
      totalTokens,
      modelKey: modelKey || '',
    });
  }
  writeAccessKeys(data);
}

function refreshAccessKeySessionById(cardId, sessionId, clientId = '') {
  if (!cardId || !sessionId) return null;
  const data = readAccessKeys();
  const record = data.keys.find((item) => item.id === cardId);
  if (!record) return null;
  const activeSessionId = normalizeSessionId(record.activeSessionId);
  if (!activeSessionId || !constantTimeEqual(activeSessionId, sessionId)) return null;
  const activeClientId = String(record.sessionClientId || '').trim();
  const requestedClientId = String(clientId || '').trim();
  if (activeClientId && requestedClientId && activeClientId !== requestedClientId) return null;
  refreshAccessKeySession(record, { clientId });
  writeAccessKeys(data);
  return record;
}

function activateAccessKey(cardId) {
  if (!cardId) return null;
  const data = readAccessKeys();
  const record = data.keys.find((item) => item.id === cardId);
  if (!record) return null;
  if (!record.firstUsedAt) {
    record.firstUsedAt = new Date().toISOString();
    writeAccessKeys(data);
  }
  return record;
}

function accessKeyPublicStatus(record) {
  if (!record) return null;
  const now = Date.now();
  pruneUsageEvents(record, now);
  const recentTokens = recentTokenUsage(record, now);
  const tokenLimit = tokenWindowLimit(record);
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
    recentWindowRequests: (record.usageEvents || []).length,
    windowLimit: Number(record.windowLimit || 0),
    windowMs: Number(record.windowMs || DEFAULT_KEY_WINDOW_MS),
    totalInputTokens: Number(record.totalInputTokens || 0),
    totalOutputTokens: Number(record.totalOutputTokens || 0),
    totalCachedInputTokens: Number(record.totalCachedInputTokens || 0),
    totalRawTokensUsed: Number(record.totalRawTokensUsed || 0),
    totalTokensUsed: Number(record.totalTokensUsed || 0),
    recentWindowInputTokens: recentTokens.inputTokens,
    recentWindowOutputTokens: recentTokens.outputTokens,
    recentWindowCachedInputTokens: recentTokens.cachedInputTokens,
    recentWindowRawTokens: recentTokens.rawTotalTokens,
    recentWindowTokens: recentTokens.totalTokens,
    opusTokensUsed: recentTokens.opusEffectiveTokens,
    opusTokenLimit: Number(record.windowLimit || 0) * 100_000,
    geminiTokensUsed: recentTokens.geminiEffectiveTokens,
    geminiTokenLimit: Number(record.windowLimit || 0) * 500_000,
    recentWindowResetMs: resetMs,
    tokenWindowLimit: tokenLimit,
    tokenWindowRemaining: tokenLimit > 0 ? Math.max(0, tokenLimit - recentTokens.totalTokens) : 0,
    tokenWindowMs: tokenWindowMs(record),
    tokenWindowStartedAt: Number(record.windowStartedAt || 0) > 0 ? new Date(record.windowStartedAt).toISOString() : '',
    tokenWindowResetMs: resetMs,
    tokenWindowResetAt: resetMs > 0 ? new Date(now + resetMs).toISOString() : '',
    lastUsedAt: record.lastUsedAt || '',
    hasActiveSession: Boolean(record.activeSessionId && !isAccessKeySessionExpired(record, now)),
    sessionClientId: record.sessionClientId || '',
    sessionStartedAt: record.sessionStartedAt || '',
    sessionLastSeenAt: record.sessionLastSeenAt || '',
    sessionExpiresAt: record.sessionExpiresAt || '',
    sessionTtlMs: accessKeySessionTtlMs(record),
  };
}

function normalizeModelKey(value) {
  return String(value || '').trim();
}

function affinityKey(clientId, modelKey) {
  return `${String(clientId || '').trim()}::${normalizeModelKey(modelKey)}`;
}

function createRemoteTokenServer(config) {
  const {
    host = '0.0.0.0',
    port = 60700,
    secret = '',
    accountsFilePath = paths.accountsPath(),
    cloudEndpoint,
    cooldownMs = 60000,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    affinityTtlMs = DEFAULT_AFFINITY_TTL_MS,
    maxConcurrentPerAccount = DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
    log = console.log,
  } = config;

  const tokenManager = createTokenManager({
    accountsFilePath,
    cloudEndpoint,
    runtimeStatePath: paths.tokenProxyStatePath(),
    log,
  });
  const quotaTracker = createQuotaTracker({ tokenManager, log, cooldownMs });
  quotaTracker.init();

  const leases = new Map();
  const accountStats = new Map();
  const clientAffinity = new Map();
  const modelGate = new Map();
  const modelPressure = new Map();
  const planTypeFetchedIds = new Set();
  let totalLeases = 0;
  let totalReports = 0;
  let totalErrors = 0;
  let lastError = null;

  // ── Daily counters (reset at midnight) ──
  const daily = { date: new Date().toISOString().slice(0, 10), leases: 0, successes: 0, errors: 0, quota429: 0, tokensUsed: 0 };
  function ensureDailyReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (daily.date !== today) {
      daily.date = today;
      daily.leases = 0;
      daily.successes = 0;
      daily.errors = 0;
      daily.quota429 = 0;
      daily.tokensUsed = 0;
    }
  }

  // ── Persistent account stats file ──
  const accountStatsPath = path.join(path.dirname(accountsFilePath), 'account-stats.json');
  let _accountStatsSaveTimer = null;

  function loadAccountStats() {
    try {
      if (fs.existsSync(accountStatsPath)) {
        const data = JSON.parse(fs.readFileSync(accountStatsPath, 'utf8'));
        for (const [id, saved] of Object.entries(data)) {
          const stats = ensureAccountStats(Number(id));
          // Restore cumulative fields only
          stats.totalLeases = Number(saved.totalLeases || 0);
          stats.totalInputTokens = Number(saved.totalInputTokens || 0);
          stats.totalOutputTokens = Number(saved.totalOutputTokens || 0);
          stats.totalTokensUsed = Number(saved.totalTokensUsed || 0);
          stats.successCount = Number(saved.successCount || 0);
          stats.errorCount = Number(saved.errorCount || 0);
          stats.quota429Count = Number(saved.quota429Count || 0);
          stats.lastSuccessAt = Number(saved.lastSuccessAt || 0);
          stats.lastUsedAt = Number(saved.lastUsedAt || 0);
        }
        log(`[remote-token] loaded account stats for ${Object.keys(data).length} accounts`);
      }
    } catch (err) {
      log(`[remote-token] failed to load account-stats.json: ${err.message}`);
    }
  }

  function saveAccountStats() {
    try {
      const data = {};
      for (const [id, stats] of accountStats.entries()) {
        data[id] = {
          totalLeases: stats.totalLeases || 0,
          totalInputTokens: stats.totalInputTokens || 0,
          totalOutputTokens: stats.totalOutputTokens || 0,
          totalTokensUsed: stats.totalTokensUsed || 0,
          successCount: stats.successCount || 0,
          errorCount: stats.errorCount || 0,
          quota429Count: stats.quota429Count || 0,
          lastSuccessAt: stats.lastSuccessAt || 0,
          lastUsedAt: stats.lastUsedAt || 0,
        };
      }
      fs.writeFileSync(accountStatsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (err) {
      log(`[remote-token] failed to save account-stats.json: ${err.message}`);
    }
  }

  function debounceSaveAccountStats() {
    if (_accountStatsSaveTimer) return;
    _accountStatsSaveTimer = setTimeout(() => {
      _accountStatsSaveTimer = null;
      saveAccountStats();
    }, 600000);
  }

  // ── Persistent model gates file (per-account model cooldowns) ──
  const modelGatesPath = path.join(path.dirname(accountsFilePath), 'model-gates.json');
  const modelPressurePath = path.join(path.dirname(accountsFilePath), 'model-pressure.json');
  let _modelGatesSaveTimer = null;

  function loadModelGates() {
    try {
      if (fs.existsSync(modelGatesPath)) {
        const data = JSON.parse(fs.readFileSync(modelGatesPath, 'utf8'));
        const now = Date.now();
        let loaded = 0;
        for (const saved of (Array.isArray(data) ? data : [])) {
          // Skip expired gates
          if (Number(saved.blockedUntil || 0) <= now && saved.state !== 'probation') continue;
          const key = `${Number(saved.accountId)}:${normalizeModelKey(saved.modelKey)}`;
          modelGate.set(key, {
            accountId: Number(saved.accountId),
            modelKey: normalizeModelKey(saved.modelKey),
            state: saved.state || 'cooling',
            failCount: Number(saved.failCount || 0),
            blockedUntil: Number(saved.blockedUntil || 0),
            nextProbeAfter: Number(saved.nextProbeAfter || 0),
            lastFailureAt: Number(saved.lastFailureAt || 0),
            lastSuccessAt: Number(saved.lastSuccessAt || 0),
            reason: saved.reason || '',
          });
          loaded++;
        }
        log(`[remote-token] loaded ${loaded} model gates (${(Array.isArray(data) ? data : []).length} on disk, ${(Array.isArray(data) ? data : []).length - loaded} expired)`);
      }
    } catch (err) {
      log(`[remote-token] failed to load model-gates.json: ${err.message}`);
    }
  }

  function saveModelGates() {
    try {
      const data = Array.from(modelGate.values()).map((gate) => ({
        accountId: gate.accountId,
        modelKey: gate.modelKey,
        state: gate.state,
        failCount: gate.failCount,
        blockedUntil: gate.blockedUntil,
        nextProbeAfter: gate.nextProbeAfter,
        lastFailureAt: gate.lastFailureAt,
        lastSuccessAt: gate.lastSuccessAt,
        reason: gate.reason || '',
      }));
      fs.writeFileSync(modelGatesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (err) {
      log(`[remote-token] failed to save model-gates.json: ${err.message}`);
    }
  }

  function loadModelPressure() {
    try {
      if (fs.existsSync(modelPressurePath)) {
        const data = JSON.parse(fs.readFileSync(modelPressurePath, 'utf8'));
        const now = Date.now();
        let loaded = 0;
        for (const saved of (Array.isArray(data) ? data : [])) {
          if (Number(saved.blockedUntil || 0) <= now) continue;
          const key = pressureKey(saved.modelKey);
          modelPressure.set(key, {
            modelKey: normalizeModelKey(saved.modelKey),
            failCount: Number(saved.failCount || 0),
            uniqueAccountCount: Number(saved.uniqueAccountCount || 0),
            uniqueAccountIds: new Set(Array.isArray(saved.uniqueAccountIds) ? saved.uniqueAccountIds : []),
            lastStatus: Number(saved.lastStatus || 0),
            firstFailureAt: Number(saved.firstFailureAt || 0),
            lastFailureAt: Number(saved.lastFailureAt || 0),
            blockedUntil: Number(saved.blockedUntil || 0),
            lastProbationProbeAt: Number(saved.lastProbationProbeAt || 0),
          });
          loaded++;
        }
        log(`[remote-token] loaded ${loaded} model pressure entries`);
      }
    } catch (err) {
      log(`[remote-token] failed to load model-pressure.json: ${err.message}`);
    }
  }

  function saveModelPressure() {
    try {
      const data = Array.from(modelPressure.values()).map((p) => ({
        modelKey: p.modelKey,
        failCount: p.failCount,
        uniqueAccountCount: p.uniqueAccountCount || 0,
        uniqueAccountIds: p.uniqueAccountIds ? Array.from(p.uniqueAccountIds) : [],
        lastStatus: p.lastStatus,
        firstFailureAt: p.firstFailureAt,
        lastFailureAt: p.lastFailureAt,
        blockedUntil: p.blockedUntil,
        lastProbationProbeAt: p.lastProbationProbeAt || 0,
      }));
      fs.writeFileSync(modelPressurePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (err) {
      log(`[remote-token] failed to save model-pressure.json: ${err.message}`);
    }
  }

  function debounceSaveModelGates() {
    if (_modelGatesSaveTimer) return;
    _modelGatesSaveTimer = setTimeout(() => {
      _modelGatesSaveTimer = null;
      saveModelGates();
      saveModelPressure();
    }, 600000);
  }

  function ensureAccountStats(accountId) {
    const id = Number(accountId);
    if (!accountStats.has(id)) {
      accountStats.set(id, {
        successCount: 0,
        errorCount: 0,
        quota429Count: 0,
        locationFailures: 0,
        recentResults: [],
        modelFailures: new Map(),
        totalLeases: 0,
        lastUsedAt: 0,
        lastStatus: 0,
        lastSuccessAt: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokensUsed: 0,
      });
    }
    return accountStats.get(id);
  }

  // Load persisted stats on startup
  loadAccountStats();
  loadModelGates();
  loadModelPressure();

  // Do an initial save shortly after startup so that any gates that were
  // constructed during tokenManager init get written to disk.
  setTimeout(() => { saveModelGates(); saveModelPressure(); }, 15000);

  function gateKey(accountId, modelKey) {
    return `${Number(accountId)}:${normalizeModelKey(modelKey)}`;
  }

  function ensureModelGate(accountId, modelKey) {
    const key = gateKey(accountId, modelKey);
    if (!modelGate.has(key)) {
      modelGate.set(key, {
        accountId: Number(accountId),
        modelKey: normalizeModelKey(modelKey),
        state: 'healthy',
        failCount: 0,
        blockedUntil: 0,
        nextProbeAfter: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
        reason: '',
      });
    }
    return modelGate.get(key);
  }

  function getModelGate(accountId, modelKey) {
    return modelGate.get(gateKey(accountId, modelKey)) || null;
  }

  function clearModelGate(accountId, modelKey) {
    modelGate.delete(gateKey(accountId, modelKey));
    debounceSaveModelGates();
  }

  function isQuotaRecoverableGateReason(reason) {
    const text = String(reason || '').toLowerCase();
    return !text ||
      text === 'quota' ||
      text === 'capacity' ||
      text === 'model_unavailable' ||
      text.includes('quota') ||
      text.includes('capacity');
  }

  function isAutoRecheckReason(reason) {
    const text = String(reason || '').toLowerCase();
    return !text ||
      text === 'quota' ||
      text === 'capacity' ||
      text === 'model_unavailable' ||
      text === 'location_probe' ||
      text.includes('quota') ||
      text.includes('capacity');
  }

  function modelQuotaFraction(account, modelKey) {
    const targetModelKey = normalizeModelKey(modelKey);
    if (!targetModelKey) return null;
    const fractions = account?.modelQuotaFractions || {};
    const value = fractions instanceof Map
      ? fractions.get(targetModelKey)
      : fractions[targetModelKey];
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isQuotaDataNewerThanGate(account, gate) {
    const refreshedAt = Number(account?.modelQuotaRefreshedAt || 0);
    if (!refreshedAt) return false;
    const failedAt = Math.max(
      Number(gate?.lastFailureAt || 0),
      Number(gate?.blockedAt || 0)
    );
    if (failedAt > 0) {
      return refreshedAt >= failedAt - 1000;
    }
    return Date.now() - refreshedAt <= 10 * 60 * 1000;
  }

  function clearRecoveredModelGate(account, modelKey) {
    const gate = getModelGate(account?.id, modelKey);
    if (!gate || gate.state === 'healthy') return null;
    if (!isQuotaRecoverableGateReason(gate.reason)) return gate;
    const fraction = modelQuotaFraction(account, modelKey);
    if (fraction !== null && fraction > 0 && isQuotaDataNewerThanGate(account, gate)) {
      clearModelGate(account.id, modelKey);
      log(`[remote-token] cleared model gate from quota-data #${account.id} ${maskEmail(account.email)} model=${normalizeModelKey(modelKey)} remaining=${fraction}`);
      return null;
    }
    return gate;
  }

  function blockedModelsArray(account) {
    const blockedModels = account?.blockedModels;
    if (!blockedModels) return [];
    if (blockedModels instanceof Map) return Array.from(blockedModels.values());
    return Array.isArray(blockedModels) ? blockedModels : [];
  }

  function getAccountModelBlock(account, modelKey, now = Date.now()) {
    const targetModelKey = normalizeModelKey(modelKey);
    if (!account || !targetModelKey) return null;
    const blocked = blockedModelsArray(account).find((item) =>
      normalizeModelKey(item?.modelKey) === targetModelKey
    );
    if (!blocked) return null;
    const blockedUntil = Number(blocked.blockedUntil || 0);
    if (blockedUntil > now || blockedUntil === 0) {
      return {
        modelKey: targetModelKey,
        reason: String(blocked.reason || account.quotaStatusReason || 'model_unavailable'),
        blockedAt: Number(blocked.blockedAt || account.exhaustedAt || 0),
        blockedUntil,
      };
    }
    return null;
  }

  function isAccountGloballyBlocked(account, now = Date.now()) {
    const blockedUntil = Number(account?.blockedUntil || 0);
    if (blockedUntil <= now) return null;
    return {
      reason: String(account?.quotaStatusReason || 'blocked'),
      blockedAt: Number(account?.exhaustedAt || 0),
      blockedUntil,
    };
  }

  function prepareAutoRecheckGate(account, modelKey, block, now = Date.now()) {
    const targetModelKey = normalizeModelKey(modelKey);
    if (!account || !targetModelKey || !block || !isAutoRecheckReason(block.reason)) return null;
    const gate = ensureModelGate(account.id, targetModelKey);
    gate.reason = block.reason || gate.reason || 'quota';
    gate.blockedAt = Number(block.blockedAt || gate.blockedAt || now);
    gate.blockedUntil = Number(block.blockedUntil || gate.blockedUntil || 0);
    gate.lastFailureAt = Math.max(Number(gate.lastFailureAt || 0), gate.blockedAt);
    const firstProbeAt = gate.blockedAt > 0 ? gate.blockedAt + AUTO_RECHECK_AFTER_MS : now;
    const existingNextProbeAfter = Number(gate.nextProbeAfter || 0);
    if (gate.state === 'cooling' && existingNextProbeAfter > now) {
      return gate;
    }
    gate.nextProbeAfter = existingNextProbeAfter > 0 ? existingNextProbeAfter : firstProbeAt;
    if (now < Number(gate.nextProbeAfter || 0)) {
      gate.state = 'cooling';
      return gate;
    }
    gate.state = 'probation';
    gate.nextProbeAfter = now;
    return gate;
  }

  function canBypassAccountBlockForProbe(account, modelKey, now = Date.now()) {
    const targetModelKey = normalizeModelKey(modelKey);
    if (!account || !targetModelKey) return false;
    const block = getAccountModelBlock(account, targetModelKey, now) ||
      isAccountGloballyBlocked(account, now);
    if (!block) return true;
    const gate = prepareAutoRecheckGate(account, targetModelKey, block, now);
    return gate?.state === 'probation' &&
      Number(gate.nextProbeAfter || 0) <= now &&
      activeProbationLeaseCount(account.id, targetModelKey, now) === 0;
  }

  function pressureKey(modelKey) {
    return normalizeModelKey(modelKey) || '(global)';
  }

  function getModelPressure(modelKey, now = Date.now()) {
    const key = pressureKey(modelKey);
    const pressure = modelPressure.get(key);
    if (!pressure) return null;
    if (Number(pressure.blockedUntil || 0) <= now) {
      modelPressure.delete(key);
      return null;
    }
    return pressure;
  }

  function recordModelPressure(modelKey, status = 503, accountId = 0, now = Date.now()) {
    const key = pressureKey(modelKey);
    const existing = modelPressure.get(key) || {
      modelKey: normalizeModelKey(modelKey),
      failCount: 0,
      firstFailureAt: now,
      blockedUntil: 0,
      recentFailures: [],
    };
    if (!existing.recentFailures) existing.recentFailures = [];
    // Add this failure to the sliding window
    existing.recentFailures.push({ accountId: Number(accountId), at: now });
    // Prune entries outside the sliding window
    existing.recentFailures = existing.recentFailures.filter(f => now - f.at < MODEL_PRESSURE_WINDOW_MS);
    // Count unique accounts within the window
    const uniqueAccounts = new Set(existing.recentFailures.map(f => f.accountId));
    existing.failCount = existing.recentFailures.length;
    existing.uniqueAccountCount = uniqueAccounts.size;
    existing.lastFailureAt = now;
    existing.lastStatus = status;
    // Only activate pressure if >= threshold unique accounts failed within the window
    if (uniqueAccounts.size >= MODEL_PRESSURE_UNIQUE_THRESHOLD) {
      existing.blockedUntil = now + Math.min(MODEL_PRESSURE_BASE_MS, MODEL_PRESSURE_MAX_MS);
    }
    // Allow rate-limited probation probes even during pressure (1 per 10s)
    existing.lastProbationProbeAt = existing.lastProbationProbeAt || 0;
    modelPressure.set(key, existing);
    return existing;
  }

  function clearModelPressure(modelKey) {
    modelPressure.delete(pressureKey(modelKey));
    debounceSaveModelGates();
  }

  function activeProbationLeaseCount(accountId, modelKey = '', now = Date.now()) {
    const targetId = Number(accountId);
    const targetModelKey = normalizeModelKey(modelKey);
    let count = 0;
    for (const lease of leases.values()) {
      if (!lease.probation || lease.released || Number(lease.accountId) !== targetId) continue;
      if (Date.parse(lease.expiresAt || '') <= now) continue;
      if (targetModelKey && normalizeModelKey(lease.modelKey) !== targetModelKey) continue;
      count++;
    }
    return count;
  }

  function serializeAccountStats() {
    return Object.fromEntries(Array.from(accountStats.entries()).map(([accountId, stats]) => [
      accountId,
      {
        ...stats,
        modelFailures: Object.fromEntries(stats.modelFailures.entries()),
      },
    ]));
  }

  function serializeModelGates(now = Date.now()) {
    return Array.from(modelGate.values()).map((gate) => ({
      accountId: gate.accountId,
      modelKey: gate.modelKey,
      state: gate.state,
      reason: gate.reason || '',
      failCount: gate.failCount,
      blockedUntil: gate.blockedUntil,
      blockedForMs: Math.max(0, Number(gate.blockedUntil || 0) - now),
      nextProbeAfter: gate.nextProbeAfter,
      nextProbeInMs: Math.max(0, Number(gate.nextProbeAfter || 0) - now),
      lastFailureAt: gate.lastFailureAt,
      lastSuccessAt: gate.lastSuccessAt,
    }));
  }

  function serializeModelPressure(now = Date.now()) {
    return Array.from(modelPressure.values()).map((pressure) => ({
      modelKey: pressure.modelKey,
      failCount: pressure.failCount,
      uniqueAccountCount: pressure.uniqueAccountCount || 0,
      threshold: MODEL_PRESSURE_UNIQUE_THRESHOLD,
      lastStatus: pressure.lastStatus,
      firstFailureAt: pressure.firstFailureAt,
      lastFailureAt: pressure.lastFailureAt,
      blockedUntil: pressure.blockedUntil,
      blockedForMs: Math.max(0, Number(pressure.blockedUntil || 0) - now),
      activated: (pressure.uniqueAccountCount || 0) >= MODEL_PRESSURE_UNIQUE_THRESHOLD,
    }));
  }

  function cleanupExpiredLeases(now = Date.now()) {
    for (const [leaseId, lease] of leases.entries()) {
      if (lease.released || Date.parse(lease.expiresAt || '') <= now) {
        leases.delete(leaseId);
      }
    }
    for (const [key, value] of clientAffinity.entries()) {
      if (Number(value.expiresAt || 0) <= now) {
        clientAffinity.delete(key);
      }
    }
    for (const [key, gate] of modelGate.entries()) {
      if (gate.state === 'healthy') {
        modelGate.delete(key);
      }
    }
    for (const [key, pressure] of modelPressure.entries()) {
      if (Number(pressure.blockedUntil || 0) <= now) {
        modelPressure.delete(key);
      }
    }
  }

  function activeLeaseCount(accountId, modelKey = '', now = Date.now()) {
    const targetId = Number(accountId);
    const targetModelKey = normalizeModelKey(modelKey);
    let count = 0;
    for (const lease of leases.values()) {
      if (lease.released || Number(lease.accountId) !== targetId) continue;
      if (Date.parse(lease.expiresAt || '') <= now) continue;
      if (targetModelKey && normalizeModelKey(lease.modelKey) !== targetModelKey) continue;
      count++;
    }
    return count;
  }

  function clearAccountAffinityAndLeases(accountId) {
    const targetId = Number(accountId);
    for (const lease of leases.values()) {
      if (Number(lease.accountId || 0) === targetId) {
        lease.released = true;
      }
    }
    for (const [key, value] of clientAffinity.entries()) {
      if (Number(value?.accountId || 0) === targetId) {
        clientAffinity.delete(key);
      }
    }
  }

  function clearAccountAffinity(accountId) {
    const targetId = Number(accountId);
    for (const [key, value] of clientAffinity.entries()) {
      if (Number(value?.accountId || 0) === targetId) {
        clientAffinity.delete(key);
      }
    }
  }

  function clearClientModelAffinity(accountId, clientId, modelKey) {
    const expectedKey = affinityKey(clientId, modelKey);
    for (const [key, value] of clientAffinity.entries()) {
      if (
        Number(value?.accountId || 0) === Number(accountId) &&
        (!expectedKey || key === expectedKey)
      ) {
        clientAffinity.delete(key);
      }
    }
  }

  function blockAccountForModel(accountId, modelKey, reason, durationMs) {
    const normalizedModel = normalizeModelKey(modelKey);
    if (!normalizedModel) return 0;
    const cooldownMs = Math.max(60_000, Number(durationMs) || 0);
    const blockedUntil = Date.now() + cooldownMs;
    const gate = ensureModelGate(accountId, normalizedModel);
    gate.state = 'cooling';
    gate.failCount = Math.max(1, Number(gate.failCount || 0) + 1);
    gate.lastFailureAt = Date.now();
    gate.blockedUntil = blockedUntil;
    gate.nextProbeAfter = Date.now() + Math.min(cooldownMs, AUTO_RECHECK_AFTER_MS);
    gate.reason = reason || 'model_unavailable';
    tokenManager.markExhausted(accountId, {
      reason: reason || 'model_unavailable',
      modelKey: normalizedModel,
      blockedUntil,
      useSuggestedBlock: true,
    });
    debounceSaveModelGates();
    return cooldownMs;
  }

  function quarantineAccount(accountId, reason, durationMs = 24 * 60 * 60 * 1000) {
    const account = tokenManager.getAccount(accountId);
    if (!account) return false;
    const blockedUntil = Date.now() + Math.max(60_000, Number(durationMs) || 0);
    clearAccountAffinity(accountId);
    tokenManager.markExhausted(accountId, {
      reason: reason || 'verification_required',
      blockedUntil,
    });
    log(`[remote-token] quarantined #${accountId} ${maskEmail(account.email)} reason=${reason || 'verification_required'} until=${new Date(blockedUntil).toISOString()}`);
    return true;
  }

  let autoRecheckRunning = false;

  async function sweepAutoRecheckCandidates() {
    if (autoRecheckRunning) return;
    autoRecheckRunning = true;
    const now = Date.now();
    let promoted = 0;
    let recovered = 0;
    let verified = 0;
    let inconclusive = 0;
    try {
      tokenManager.loadAccounts();
      for (const account of tokenManager.listAccounts()) {
        if (!account.enabled || !account.projectId) continue;
        for (const block of blockedModelsArray(account)) {
          const modelKey = normalizeModelKey(block?.modelKey);
          if (!modelKey || !isAutoRecheckReason(block?.reason)) continue;
          const gate = ensureModelGate(account.id, modelKey);
          gate.reason = String(block.reason || gate.reason || 'quota');
          gate.blockedAt = Number(block.blockedAt || gate.blockedAt || account.exhaustedAt || now);
          gate.blockedUntil = Number(block.blockedUntil || gate.blockedUntil || 0);
          gate.lastFailureAt = Math.max(Number(gate.lastFailureAt || 0), gate.blockedAt);
          if (isQuotaRecoverableGateReason(gate.reason)) {
            const fraction = modelQuotaFraction(account, modelKey);
            if (fraction !== null && fraction > 0 && isQuotaDataNewerThanGate(account, gate)) {
              tokenManager.markSuccess(account.id, { modelKey });
              clearModelGate(account.id, modelKey);
              recovered++;
              log(`[remote-token] auto-recheck recovered from quota-data #${account.id} ${maskEmail(account.email)} model=${modelKey} remaining=${fraction}`);
              continue;
            }
          }
          const prepared = prepareAutoRecheckGate(account, modelKey, gate, now);
          if (prepared?.state === 'probation' && Number(prepared.autoRecheckLoggedAt || 0) < now - AUTO_RECHECK_AFTER_MS) {
            prepared.autoRecheckLoggedAt = now;
            promoted++;
            log(`[remote-token] auto-recheck promoted #${account.id} ${maskEmail(account.email)} model=${modelKey} reason=${prepared.reason}`);
          }
          if (
            prepared?.state === 'probation' &&
            isQuotaRecoverableGateReason(prepared.reason) &&
            verified < AUTO_RECHECK_VERIFY_LIMIT &&
            typeof tokenManager.verifyModelQuota === 'function'
          ) {
            verified++;
            const result = await tokenManager.verifyModelQuota(account.id, modelKey);
            if (result?.hasQuota || (result && result.remainingFraction === null)) {
              tokenManager.markSuccess(account.id, { modelKey });
              clearModelGate(account.id, modelKey);
              recovered++;
              log(`[remote-token] auto-recheck live recovered #${account.id} ${maskEmail(account.email)} model=${modelKey} remaining=${result.remainingFraction ?? 'N/A'}`);
            } else if (result) {
              const longCooldownMs = SECOND_QUOTA_COOLDOWN_MS;
              prepared.state = 'cooling';
              prepared.nextProbeAfter = Date.now() + longCooldownMs;
              prepared.blockedUntil = Math.max(Number(prepared.blockedUntil || 0), prepared.nextProbeAfter);
              prepared.reason = 'quota';
              quotaTracker.reportQuotaExhausted(account.id, {
                reason: 'quota',
                modelKey,
                retryAfterMs: longCooldownMs,
                useSuggestedBlock: true,
              });
              log(`[remote-token] auto-recheck live confirmed long cooldown #${account.id} ${maskEmail(account.email)} model=${modelKey} remaining=${result.remainingFraction}`);
            } else {
              inconclusive++;
              prepared.nextProbeAfter = Date.now() + AUTO_RECHECK_AFTER_MS;
            }
          }
        }
      }
      if (recovered || promoted || verified || inconclusive) {
        log(`[remote-token] auto-recheck sweep recovered=${recovered} promoted=${promoted} verified=${verified} inconclusive=${inconclusive}`);
      }
    } catch (error) {
      log(`[remote-token] auto-recheck sweep failed: ${error.message}`);
    } finally {
      debounceSaveModelGates();
      autoRecheckRunning = false;
    }
  }

  function isAccountBlockedForModel(account, modelKey, now = Date.now()) {
    const blockedUntil = Number(account?.blockedUntil || 0);
    if (blockedUntil > now) return true;
    const targetModelKey = normalizeModelKey(modelKey);
    if (!targetModelKey) return false;
    const blockedModels = Array.isArray(account?.blockedModels) ? account.blockedModels : [];
    const blocked = blockedModels.find((item) => normalizeModelKey(item?.modelKey) === targetModelKey);
    if (!blocked) return false;
    const modelBlockedUntil = Number(blocked.blockedUntil || 0);
    return modelBlockedUntil > now || modelBlockedUntil === 0;
  }

  // ── Enterprise account adaptive probing ──────────────────────────────
  // Non-gmail accounts (yachts / asia domains) have high quotas but strict
  // per-minute rate limits.  We track their success rate in 30-min cycles
  // and dynamically adjust their selection weight.
  const ENTERPRISE_CYCLE_MS = 10 * 60 * 1000;   // 10 minutes
  const ENTERPRISE_PROBE_PHASE_MS = 3 * 60 * 1000; // first 3 min = probe phase
  const ENTERPRISE_MIN_SAMPLES = 4;              // min probes before adjusting weight
  const ENTERPRISE_EMERGENCY_THRESHOLD = 5;      // consecutive failures → emergency
  const enterpriseGroups = {};

  function newEnterpriseGroupEntry() {
    return { cycleStart: Date.now(), successes: 0, failures: 0, consecutiveFails: 0, weight: 3, emergency: false };
  }

  function getEnterpriseGroup(email) {
    const e = String(email || '').toLowerCase();
    if (e.endsWith('@gmail.com')) return null;
    const atIdx = e.indexOf('@');
    if (atIdx < 0) return null;
    // Use the full domain as the group key
    return e.substring(atIdx + 1);
  }

  function ensureEnterpriseCycle(group) {
    if (!enterpriseGroups[group]) {
      enterpriseGroups[group] = newEnterpriseGroupEntry();
    }
    const g = enterpriseGroups[group];
    const now = Date.now();
    if (now - g.cycleStart >= ENTERPRISE_CYCLE_MS) {
      // New cycle — no inheritance, reset everything
      const oldRate = (g.successes + g.failures) > 0
        ? Math.round(g.successes / (g.successes + g.failures) * 100) : -1;
      log(`[enterprise-probe] ${group} cycle reset (prev: ${g.successes}ok/${g.failures}fail=${oldRate}% → weight was ${g.weight.toFixed(1)})`);
      g.cycleStart = now;
      g.successes = 0;
      g.failures = 0;
      g.consecutiveFails = 0;
      g.weight = 3; // default ultra weight for probing
      g.emergency = false;
    }
    return g;
  }

  function reportEnterpriseResult(email, success) {
    const group = getEnterpriseGroup(email);
    if (!group) return;
    const g = ensureEnterpriseCycle(group);
    if (!g) return;

    if (success) {
      g.successes++;
      g.consecutiveFails = 0;
      g.emergency = false;
    } else {
      g.failures++;
      g.consecutiveFails++;
    }

    // Recalculate weight (only after enough samples)
    const total = g.successes + g.failures;
    if (total >= ENTERPRISE_MIN_SAMPLES) {
      const rate = g.successes / total;
      if (rate > 0.5) {
        g.weight = 6;  // Better than ultra — use heavily
      } else if (rate > 0.3) {
        g.weight = 3;  // Normal ultra
      } else if (rate > 0.15) {
        g.weight = 1.5; // Reduced
      } else {
        g.weight = 0.5; // Almost disabled
      }
    }

    // Emergency: consecutive failures → immediate cutoff
    if (g.consecutiveFails >= ENTERPRISE_EMERGENCY_THRESHOLD && !g.emergency) {
      g.emergency = true;
      g.weight = 0.5;
      log(`[enterprise-probe] ${group} EMERGENCY: ${g.consecutiveFails} consecutive failures → weight 0.5`);
    }
  }

  function accountWeight(account) {
    const configured = Number(account.remoteWeight ?? account.weight ?? 0);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const plan = String(account.planType || '').toLowerCase();
    const baseWeight = plan.includes('ultra') ? 3
      : (plan.includes('premium') || plan.includes('pro')) ? 2
      : 1;

    // Apply enterprise adaptive weight if applicable
    const group = getEnterpriseGroup(account.email);
    if (group) {
      const g = ensureEnterpriseCycle(group);
      if (g) {
        // During probe phase (first 3 min), keep weight >= 3 to gather samples
        const inProbePhase = (Date.now() - g.cycleStart) < ENTERPRISE_PROBE_PHASE_MS;
        if (inProbePhase) return Math.max(3, g.weight);
        // During low-weight periods, maintain a minimum floor (0.3) for exploratory probes
        // This ensures the account still gets ~5% of traffic to detect recovery
        if (g.weight <= 1.5) return Math.max(0.3, g.weight);
        return g.weight;
      }
    }

    return baseWeight;
  }

  function scoreAccount(account, options) {
    const now = options.now;
    const stats = ensureAccountStats(account.id);
    const totalActive = activeLeaseCount(account.id, '', now);
    const modelActive = activeLeaseCount(account.id, options.modelKey, now);
    const affinity = options.preferredAccountId === account.id ? -20000 : 0;
    const recentlyUsedMs = stats.lastUsedAt ? Math.max(0, 60_000 - (now - stats.lastUsedAt)) : 0;
    const recentUsePenalty = Math.ceil(recentlyUsedMs / 1000);

    return (
      modelActive * 2000 +
      totalActive * 1000 +
      recentUsePenalty -
      accountWeight(account) * 20 +
      affinity
    );
  }

  // ── 全局错误频率追踪（滑动窗口 60s）──
  const ERROR_RATE_WINDOW_MS = 60 * 1000;
  const errorRateTracker = {
    events: [],
    record(status, modelKey) {
      this.events.push({ status, modelKey: normalizeModelKey(modelKey), at: Date.now() });
    },
    prune(now = Date.now()) {
      this.events = this.events.filter(e => now - e.at < ERROR_RATE_WINDOW_MS);
    },
    rates(modelKey, now = Date.now()) {
      this.prune(now);
      const model = normalizeModelKey(modelKey);
      const relevant = model
        ? this.events.filter(e => e.modelKey === model)
        : this.events;
      const total = relevant.length || 1;
      return {
        count503: relevant.filter(e => e.status === 503).length,
        count429: relevant.filter(e => e.status === 429).length,
        total,
        rate503: relevant.filter(e => e.status === 503).length / total,
        rate429: relevant.filter(e => e.status === 429).length / total,
      };
    },
  };

  // ── 手动节流配置 ──
  const THROTTLE_CONFIG_PATH = path.join(path.dirname(accountsFilePath), 'throttle-config.json');
  let _throttleConfigCache = null;
  let _throttleConfigMtime = 0;

  function readThrottleConfig() {
    try {
      if (!fs.existsSync(THROTTLE_CONFIG_PATH)) return null;
      const stat = fs.statSync(THROTTLE_CONFIG_PATH);
      if (_throttleConfigCache && stat.mtimeMs === _throttleConfigMtime) {
        return _throttleConfigCache;
      }
      _throttleConfigCache = JSON.parse(fs.readFileSync(THROTTLE_CONFIG_PATH, 'utf8'));
      _throttleConfigMtime = stat.mtimeMs;
      return _throttleConfigCache;
    } catch {
      return null;
    }
  }

  function buildRetryPolicy(candidateStats = {}, options = {}) {
    const healthy = Math.max(0, Number(candidateStats.healthyForModel || candidateStats.healthy || 0));
    const total = Math.max(0, Number(candidateStats.total || 0));
    const pressure = options.pressure || null;
    const probation = Boolean(options.probation);
    const modelKey = normalizeModelKey(options.modelKey || '');
    const config = readThrottleConfig();
    const globalCfg = config?.global || {};
    const modelCfg = modelKey && config?.models?.[modelKey] || {};
    const escalation = config?.autoEscalation || {};
    const emergency = config?.emergency || {};

    // ── 获取 503/429 频率 ──
    const rates = errorRateTracker.rates(modelKey);

    // ── 紧急模式：覆盖一切 ──
    if (emergency.enabled) {
      return {
        maxAttempts: Number(emergency.maxAttempts || 3),
        baseDelayMs: Number(emergency.baseDelayMs || 5000),
        maxDelayMs: Number(emergency.maxDelayMs || 15000),
        backoffMultiplier: 1.5,
        capacityWaitMs: Number(emergency.capacityWaitMs || 10000),
        quotaWaitMs: Number(emergency.quotaWaitMs || 5000),
        jitterMs: 1000,
        retryableStatuses: [429, 503],
        statusMaxAttempts: { 429: 2, 503: 2 },
        reason: 'emergency',
        message: emergency.message || '',
        pressureUntil: 0,
        poolHealthy: healthy, poolTotal: total, poolPressure: Boolean(pressure),
        recent503Rate: Math.round(rates.rate503 * 100) / 100,
        recent429Rate: Math.round(rates.rate429 * 100) / 100,
      };
    }

    // ── 基于号池健康度的自动计算 ──
    let maxAttempts, baseDelayMs, maxDelayMs, backoffMultiplier;
    let capacityWaitMs, quotaWaitMs, jitterMs;

    // maxAttempts：号越多越大胆
    if (healthy >= 50)      maxAttempts = 99;
    else if (healthy >= 20) maxAttempts = Math.min(healthy * 2, 60);
    else if (healthy >= 5)  maxAttempts = Math.max(8, healthy * 2);
    else if (healthy >= 2)  maxAttempts = 5;
    else                    maxAttempts = 3;

    // baseDelayMs：号越少越慢
    if (pressure)           baseDelayMs = 1500;
    else if (healthy >= 50) baseDelayMs = 100;
    else if (healthy >= 20) baseDelayMs = 200;
    else if (healthy >= 5)  baseDelayMs = 400;
    else if (healthy >= 2)  baseDelayMs = 800;
    else                    baseDelayMs = 2000;

    // maxDelayMs
    maxDelayMs = healthy >= 20 ? 5000 : healthy >= 5 ? 8000 : 15000;

    // backoffMultiplier：号少时退避更激进
    backoffMultiplier = healthy >= 20 ? 1.2 : healthy >= 5 ? 1.3 : 1.5;

    // capacityWaitMs (503)
    capacityWaitMs = pressure ? 5000 : healthy >= 10 ? 1000 : 3000;

    // quotaWaitMs (429)
    quotaWaitMs = healthy >= 10 ? 500 : 1500;

    // jitterMs
    jitterMs = Math.min(500, baseDelayMs);

    // ── 503 频率自动升级 ──
    const defaultThresholds = [
      { rate503: 0.3, addDelayMs: 500 },
      { rate503: 0.5, addDelayMs: 1500 },
      { rate503: 0.8, addDelayMs: 3000 },
    ];
    const thresholds = (escalation.enabled === false) ? [] : (Array.isArray(escalation.thresholds) ? escalation.thresholds : defaultThresholds);
    for (const t of thresholds) {
      if (rates.rate503 >= (t.rate503 || 1)) {
        baseDelayMs += Number(t.addDelayMs || 0);
        capacityWaitMs += Number(t.addDelayMs || 0);
      }
    }

    // ── 手动覆盖（per-model 优先于 global）──
    const override = (key) => {
      if (modelCfg[key] != null) return modelCfg[key];
      if (globalCfg[key] != null) return globalCfg[key];
      return null;
    };
    if (override('maxAttempts') != null) maxAttempts = override('maxAttempts');
    if (override('baseDelayMs') != null) baseDelayMs = override('baseDelayMs');
    if (override('maxDelayMs') != null) maxDelayMs = override('maxDelayMs');
    if (override('backoffMultiplier') != null) backoffMultiplier = override('backoffMultiplier');
    if (override('capacityWaitMs') != null) capacityWaitMs = override('capacityWaitMs');
    if (override('quotaWaitMs') != null) quotaWaitMs = override('quotaWaitMs');
    if (override('jitterMs') != null) jitterMs = override('jitterMs');

    let reason;
    if (pressure) reason = 'model_pressure';
    else if (probation) reason = 'probation_probe';
    else if (healthy >= 50) reason = 'massive_pool';
    else if (healthy >= 20) reason = 'healthy_pool';
    else if (healthy >= 5) reason = 'moderate_pool';
    else if (healthy >= 2) reason = 'limited_pool';
    else reason = 'degraded_pool';

    return {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      backoffMultiplier,
      capacityWaitMs,
      quotaWaitMs,
      jitterMs,
      retryableStatuses: [401, 403, 429, 503],
      statusMaxAttempts: {
        401: Math.min(maxAttempts, 3),
        403: Math.min(maxAttempts, 5),
        429: maxAttempts,
        503: maxAttempts,
      },
      reason,
      pressureUntil: pressure ? Number(pressure.blockedUntil || 0) : 0,
      poolHealthy: healthy,
      poolTotal: total,
      poolPressure: Boolean(pressure),
      recent503Rate: Math.round(rates.rate503 * 100) / 100,
      recent429Rate: Math.round(rates.rate429 * 100) / 100,
    };
  }

  function selectLeaseCandidate(accounts, options) {
    const now = options.now;
    const limit = Math.max(1, Number(maxConcurrentPerAccount) || DEFAULT_MAX_CONCURRENT_PER_ACCOUNT);
    const excluded = options.excludeAccountIds instanceof Set ? options.excludeAccountIds : new Set();
    const targetModelKey = normalizeModelKey(options.modelKey);
    const pressure = targetModelKey ? getModelPressure(targetModelKey, now) : null;
    const baseCandidates = accounts.filter((account) =>
      account.enabled &&
      account.projectId &&
      account.quotaStatus !== 'error' &&
      !excluded.has(Number(account.id))
    );

    const healthyCandidates = [];
    const probationCandidates = [];

    for (const account of baseCandidates) {
      const modelBlock = targetModelKey ? getAccountModelBlock(account, targetModelKey, now) : null;
      const globalBlock = !modelBlock ? isAccountGloballyBlocked(account, now) : null;
      let gate = targetModelKey ? clearRecoveredModelGate(account, targetModelKey) : null;
      if (targetModelKey && (modelBlock || globalBlock)) {
        gate = prepareAutoRecheckGate(account, targetModelKey, modelBlock || globalBlock, now);
        if (gate?.state === 'probation') {
          const canProbe = Number(gate.nextProbeAfter || 0) <= now &&
            activeProbationLeaseCount(account.id, targetModelKey, now) === 0;
          if (canProbe) probationCandidates.push(account);
        }
        continue;
      }
      if (gate?.state === 'cooling' && Number(gate.blockedUntil || 0) > now) continue;
      if (gate?.state === 'cooling' && Number(gate.blockedUntil || 0) <= now) {
        gate.state = 'probation';
        gate.nextProbeAfter = Math.max(Number(gate.nextProbeAfter || 0), now);
      }

      if (gate?.state === 'probation') {
        const canProbe = Number(gate.nextProbeAfter || 0) <= now &&
          activeProbationLeaseCount(account.id, targetModelKey, now) === 0;
        if (canProbe) probationCandidates.push(account);
        continue;
      }

      healthyCandidates.push(account);
    }

    const healthyUnderLimit = healthyCandidates.filter((account) => activeLeaseCount(account.id, '', now) < limit);
    const healthyPool = healthyUnderLimit.length > 0 ? healthyUnderLimit : healthyCandidates;
    // During model pressure, allow rate-limited probation probes (1 per 10s)
    // instead of completely blocking, to avoid deadlock when healthyPool=0
    let pressureAllowsProbe = false;
    if (pressure && healthyPool.length === 0 && probationCandidates.length > 0) {
      const lastProbe = Number(pressure.lastProbationProbeAt || 0);
      if (now - lastProbe >= 10_000) {
        pressureAllowsProbe = true;
        pressure.lastProbationProbeAt = now;
      }
    }
    const useProbation = (!pressure || pressureAllowsProbe) && healthyPool.length < MIN_HEALTHY_CANDIDATES && probationCandidates.length > 0;
    const candidates = useProbation ? probationCandidates : healthyPool;

    if (candidates.length === 0) return null;

    const selected = candidates
      .map((account) => ({
        account,
        score: scoreAccount(account, options),
        activeLeases: activeLeaseCount(account.id, '', now),
      }))
      .sort((a, b) =>
        a.score - b.score ||
        a.activeLeases - b.activeLeases ||
        Number(a.account.lastUsedAt || 0) - Number(b.account.lastUsedAt || 0) ||
        Number(a.account.id) - Number(b.account.id)
      );

    // Debug: trace affinity miss
    if (options.preferredAccountId && selected[0].account.id !== options.preferredAccountId) {
      const prefInCandidates = selected.find(c => c.account.id === options.preferredAccountId);
      if (prefInCandidates) {
        log(`[remote-token] ⚠ affinity miss: preferred=#${options.preferredAccountId} (score=${prefInCandidates.score}) lost to #${selected[0].account.id} (score=${selected[0].score})`);
      } else {
        log(`[remote-token] ⚠ affinity miss: preferred=#${options.preferredAccountId} NOT in candidates (filtered by gate/block/probation)`);
      }
    }

    const winner = selected[0].account;

    return {
      account: winner,
      probation: useProbation,
      candidateStats: {
        availableForModel: healthyPool.length,
        healthyForModel: healthyPool.length,
        probationForModel: probationCandidates.length,
        coolingForModel: baseCandidates.length - healthyCandidates.length - probationCandidates.length,
        healthy: healthyCandidates.length,
        probation: probationCandidates.length,
        total: baseCandidates.length,
        excluded: excluded.size,
        pressure: Boolean(pressure),
        pressureUntil: pressure ? Number(pressure.blockedUntil || 0) : 0,
      },
      retryPolicy: buildRetryPolicy({
        healthyForModel: healthyPool.length,
        probationForModel: probationCandidates.length,
        total: baseCandidates.length,
      }, {
        pressure,
        probation: useProbation,
        modelKey: targetModelKey,
      }),
    };
  }

  async function getLeaseCandidateToken(modelKey, clientId, options = {}) {
    cleanupExpiredLeases();
    tokenManager.loadAccounts();
    const accounts = tokenManager.listAccounts();
    const now = Date.now();
    // ── Client-level affinity with model fallback ──
    // First try the exact clientId::model binding.
    // If none, look for any binding on the same clientId (different model)
    // and reuse that account if it's not cooling for the requested model.
    let preferredAccountId = 0;
    const modelAffinity = clientId ? clientAffinity.get(affinityKey(clientId, modelKey)) : null;
    if (modelAffinity && Number(modelAffinity.expiresAt || 0) > now) {
      preferredAccountId = Number(modelAffinity.accountId);
    } else if (clientId) {
      const clientPrefix = String(clientId).trim() + '::';
      for (const [key, value] of clientAffinity.entries()) {
        if (!key.startsWith(clientPrefix)) continue;
        if (Number(value.expiresAt || 0) <= now) continue;
        const candidateAccountId = Number(value.accountId);
        // Check that this account is not cooling for the requested model
        const gate = getModelGate(candidateAccountId, modelKey);
        const isCooling = gate && gate.state === 'cooling' && Number(gate.blockedUntil || 0) > now;
        if (!isCooling) {
          preferredAccountId = candidateAccountId;
          break;
        }
      }
    }
    const selection = selectLeaseCandidate(accounts, {
      now,
      modelKey,
      clientId,
      preferredAccountId,
      excludeAccountIds: options.excludeAccountIds,
    });

    const selectedAccount = selection?.account || null;

    // ── Early affinity: set binding immediately so concurrent requests
    //    from the same client see it before the async token fetch completes.
    if (selectedAccount && clientId) {
      const earlyAffinity = {
        accountId: selectedAccount.id,
        expiresAt: Date.now() + Math.max(60_000, Number(affinityTtlMs) || DEFAULT_AFFINITY_TTL_MS),
      };
      clientAffinity.set(affinityKey(clientId, modelKey), earlyAffinity);
      // Also migrate other models for this client
      const clientPrefix = String(clientId).trim() + '::';
      for (const [key, value] of clientAffinity.entries()) {
        if (key.startsWith(clientPrefix) && key !== affinityKey(clientId, modelKey)) {
          value.accountId = selectedAccount.id;
          value.expiresAt = earlyAffinity.expiresAt;
        }
      }
    }

    const ordered = selectedAccount
      ? [selectedAccount, ...accounts.filter((account) => account.id !== selectedAccount.id)]
      : accounts;

    let lastTokenError = null;
    let permanentTokenRefreshFailures = 0;
    for (const account of ordered) {
      if (
        !account.enabled ||
        !account.projectId ||
        account.quotaStatus === 'error' ||
        options.excludeAccountIds?.has(Number(account.id))
      ) {
        continue;
      }
      if (
        isAccountBlockedForModel(account, modelKey, now) &&
        !(selectedAccount?.id === account.id && canBypassAccountBlockForProbe(account, modelKey, now))
      ) {
        continue;
      }
      const gate = normalizeModelKey(modelKey) ? getModelGate(account.id, modelKey) : null;
      const recoveredGate = normalizeModelKey(modelKey) ? clearRecoveredModelGate(account, modelKey) : gate;
      if (recoveredGate !== gate) {
        // Use the recovered value for subsequent checks.
      }
      const activeGate = recoveredGate;
      if (activeGate?.state === 'cooling' && Number(activeGate.blockedUntil || 0) > now) continue;
      if (activeGate?.state === 'probation') {
        if (selectedAccount?.id !== account.id) continue;
        if (Number(activeGate.nextProbeAfter || 0) > now) continue;
        if (activeProbationLeaseCount(account.id, modelKey, now) > 0) continue;
      }
      try {
        const token = await tokenManager.getAccessToken(account.id);
        quotaTracker.setActiveAccount(account.id, 'remote_lease');
        const stats = ensureAccountStats(account.id);
        stats.totalLeases++;
        stats.lastUsedAt = Date.now();

        // ── Lazy planType fetch: if account has no planType, discover it in background.
        //    Only attempts once per account per server lifetime.
        if (!account.planType && !planTypeFetchedIds.has(account.id)) {
          planTypeFetchedIds.add(account.id);
          setImmediate(async () => {
            try {
              const freshToken = await tokenManager.getAccessToken(account.id);
              const { fetchPlanViaLoadCodeAssist } = require('../token-proxy/token-manager');
              if (typeof fetchPlanViaLoadCodeAssist !== 'function') return;
              // Use the instance method if available
              if (typeof tokenManager.autoFetchPlanTypes === 'function') {
                // Single-account fetch via internal API
                const rawAccount = tokenManager.getAccount(account.id);
                if (!rawAccount || rawAccount.planType) return;
                const cloudEndpoint = 'https://cloudcode-pa.clients6.google.com';
                const payload = { metadata: { ideType: 'ANTIGRAVITY' } };
                const body = JSON.stringify(payload);
                const https = require('https');
                const url = new URL(`${cloudEndpoint}/v1internal:loadCodeAssist`);
                const resData = await new Promise((resolve, reject) => {
                  const req = https.request(url, {
                    method: 'POST',
                    headers: {
                      'authorization': `Bearer ${freshToken}`,
                      'content-type': 'application/json',
                      'content-length': String(Buffer.byteLength(body)),
                    },
                  }, (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
                  });
                  req.on('error', reject);
                  req.end(body);
                });
                if (resData.statusCode >= 200 && resData.statusCode < 300) {
                  const data = JSON.parse(resData.body);
                  let tier = data.paidTier?.name || data.paidTier?.id || '';
                  if (!tier) {
                    const isIneligible = Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0;
                    if (!isIneligible) tier = data.currentTier?.name || data.currentTier?.id || '';
                  }
                  const raw = String(tier).toLowerCase();
                  let planType = '';
                  if (raw.includes('ultra')) planType = 'ultra';
                  else if (raw.includes('premium') || raw.includes('ai pro') || raw.includes('helium')) planType = 'premium';
                  else if (raw.includes('standard')) planType = 'standard';
                  else if (raw.includes('restricted')) planType = 'standard-restricted';
                  else if (tier) planType = tier;
                  if (planType) {
                    rawAccount.planType = planType;
                    tokenManager.saveAccounts();
                    log(`[remote-token] lazy planType: #${account.id} ${account.email} → ${planType}`);
                  }
                }
              }
            } catch (err) {
              log(`[remote-token] lazy planType error #${account.id}: ${err.message}`);
            }
          });
        }

        return {
          token,
          accountId: account.id,
          email: account.email,
          projectId: account.projectId,
          modelKey,
          probation: Boolean(selection?.probation && selectedAccount?.id === account.id),
          candidateStats: selection?.candidateStats || null,
          retryPolicy: selection?.retryPolicy || null,
        };
      } catch (error) {
        lastTokenError = error;
        log(`[remote-token] token refresh failed #${account.id}: ${error.message}`);
        if (isPermanentTokenRefreshError(error.message)) {
          permanentTokenRefreshFailures++;
          quarantineAccount(account.id, 'token_refresh_failed', TOKEN_REFRESH_FAILURE_COOLDOWN_MS);
          continue;
        }
      }
    }

    if (lastTokenError && permanentTokenRefreshFailures === 0) throw lastTokenError;
    if (permanentTokenRefreshFailures > 0) {
      throw new Error('No available accounts after quarantining token refresh failures.');
    }
    throw new Error('No enabled account with projectId is available.');
  }

  async function leaseToken(req, res, payload) {
    const requestedModelKey = String(payload.modelKey || payload.model || '').trim();
    const auth = resolveAccessKey(req, payload, { 
      activate: false, 
      enforceLimit: true,
      modelKey: requestedModelKey 
    });
    if (!auth.record) {
      totalErrors++;
      return sendJson(res, 401, { ok: false, error: auth.error || 'Unauthorized' });
    }

    try {
      const modelKey = String(payload.modelKey || payload.model || '').trim();
      const clientId = String(payload.clientId || payload.client || '').trim();
      const now = Date.now();
      verifyIntegrityHash(payload.integrityHash, auth.record.id, log);
      const versionCheck = validateClientVersion(payload);
      if (!versionCheck.ok) {
        totalErrors++;
        return sendJson(res, versionCheck.statusCode || 426, {
          ok: false,
          code: 'CLIENT_UPGRADE_REQUIRED',
          error: `当前插件版本过低，请升级 BCAI 插件到 ${versionCheck.minClientVersion} 或以上版本后继续使用`,
          message: `当前插件版本过低，请升级 BCAI 插件到 ${versionCheck.minClientVersion} 或以上版本后继续使用`,
          clientVersion: versionCheck.clientVersion || '',
          minClientVersion: versionCheck.minClientVersion,
          upgradeUrl: versionCheck.upgradeUrl,
          upgradeRequired: true,
          missingClientVersion: Boolean(versionCheck.missingClientVersion),
        });
      }
      const sessionCheck = validateAccessKeySession(auth.record, payload, now);
      if (!sessionCheck.ok) {
        totalErrors++;
        return sendJson(res, sessionCheck.statusCode || 409, {
          ok: false,
          error: sessionCheck.error,
          sessionClientId: sessionCheck.sessionClientId,
          sessionExpiresAt: sessionCheck.sessionExpiresAt,
          accessKeyStatus: accessKeyPublicStatus(auth.record),
        });
      }
      const accessKeySessionId = refreshAccessKeySession(auth.record, { clientId }, now, {
        create: sessionCheck.action === 'create',
        rotate: sessionCheck.action === 'refresh',
      });
      writeAccessKeys(auth.data);
      const excludeAccountIds = new Set(
        (Array.isArray(payload.excludeAccountIds) ? payload.excludeAccountIds : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      const tokenInfo = await getLeaseCandidateToken(modelKey, clientId, { excludeAccountIds });
      if (!tokenInfo.projectId) {
        throw new Error('No account with projectId is available.');
      }

      const leaseId = crypto.randomUUID();
      const configuredLeaseTtlMs = Number(leaseTtlMs) || DEFAULT_LEASE_TTL_MS;
      const ttlMs = Math.max(
        60_000,
        Math.min(configuredLeaseTtlMs, accessKeySessionTtlMs(auth.record), MAX_REMOTE_LEASE_TTL_MS)
      );
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      if (clientId) {
        for (const lease of leases.values()) {
          if (
            lease.clientId === clientId &&
            normalizeModelKey(lease.modelKey) === normalizeModelKey(modelKey) &&
            lease.accountId !== tokenInfo.accountId
          ) {
            lease.released = true;
          }
        }
      }
      leases.set(leaseId, {
        leaseId,
        accountId: tokenInfo.accountId,
        email: tokenInfo.email,
        projectId: tokenInfo.projectId,
        clientId,
        modelKey,
        accessKeyId: auth.record.id,
        accessKeySessionId,
        createdAt: Date.now(),
        expiresAt,
        released: false,
        probation: Boolean(tokenInfo.probation),
        isGeneration: Boolean(payload.isGeneration !== false),
        requestBodyBytes: Math.max(0, Number(payload.bodyBytes || payload.requestBodyBytes || 0)),
      });
      if (tokenInfo.probation && modelKey) {
        const gate = ensureModelGate(tokenInfo.accountId, modelKey);
        gate.state = 'probation';
        gate.nextProbeAfter = Date.now() + PROBATION_INTERVAL_MS;
        gate.reason = gate.reason || 'probation_retry';
      }
      if (clientId) {
        const newAffinity = {
          accountId: tokenInfo.accountId,
          expiresAt: Date.now() + Math.max(60_000, Number(affinityTtlMs) || DEFAULT_AFFINITY_TTL_MS),
        };
        // Update the current model's affinity
        clientAffinity.set(affinityKey(clientId, modelKey), newAffinity);
        // Also migrate all other model affinities for this client to the same account,
        // so that agent/flash-lite follow when opus switches to a new account.
        const clientPrefix = String(clientId).trim() + '::';
        for (const [key, value] of clientAffinity.entries()) {
          if (key.startsWith(clientPrefix) && key !== affinityKey(clientId, modelKey)) {
            value.accountId = tokenInfo.accountId;
            value.expiresAt = newAffinity.expiresAt;
          }
        }
      }
      totalLeases++;
      ensureDailyReset();
      daily.leases++;
      const accessKeyRecord = activateAccessKey(auth.record.id) || auth.record;

      log(
        `[remote-token] lease ${leaseId} -> #${tokenInfo.accountId} ${maskEmail(tokenInfo.email)} ` +
        `client=${clientId || '-'} model=${modelKey || '(empty)'} active=${activeLeaseCount(tokenInfo.accountId)} ` +
        `probation=${tokenInfo.probation ? 'yes' : 'no'} candidates=${JSON.stringify(tokenInfo.candidateStats || {})} ` +
        `retry=${JSON.stringify(tokenInfo.retryPolicy || {})} ` +
        `project=${tokenInfo.projectId}`
      );
      sendJson(res, 200, {
        ok: true,
        leaseId,
        accessKeySessionId,
        sessionId: accessKeySessionId,
        sessionExpiresAt: auth.record.sessionExpiresAt || '',
        accessKeyStatus: accessKeyPublicStatus(accessKeyRecord),
        accountId: tokenInfo.accountId,
        emailHint: maskEmail(tokenInfo.email),
        accessToken: tokenInfo.token,
        projectId: tokenInfo.projectId,
        expiresAt,
        probation: Boolean(tokenInfo.probation),
        candidateStats: tokenInfo.candidateStats || null,
        retryPolicy: tokenInfo.retryPolicy || null,
      });
    } catch (error) {
      totalErrors++;
      lastError = error.message;
      log(`[remote-token] lease error: ${error.message}`);
      sendJson(res, 503, { ok: false, error: error.message });
    }
  }

  function isQuotaExhaustedReport(status, payload) {
    const text = `${payload.errorText || ''} ${payload.message || ''}`.toLowerCase();
    return status === 429 && (
      text.includes('resource_exhausted') ||
      text.includes('quota_exhausted') ||
      text.includes('you have exhausted your capacity') ||
      text.includes('quotaresetdelay') ||
      text.includes('quota reset')
    );
  }

  function remoteCooldownMs(status, payload, stats, modelKey) {
    const retryAfterMs = Math.max(0, Number(payload.retryAfterMs || 0));
    const normalizedModel = normalizeModelKey(modelKey);
    const failureKey = normalizedModel || '(global)';
    const previous = Number(stats.modelFailures.get(failureKey) || 0);

    if (isQuotaExhaustedReport(status, payload) && normalizedModel) {
      const failCount = previous + 1;
      stats.modelFailures.set(failureKey, failCount);
      if (failCount <= 1) {
        return Math.min(retryAfterMs || FIRST_QUOTA_COOLDOWN_MS, FIRST_QUOTA_COOLDOWN_MS);
      }
      if (failCount === 2) {
        return Math.min(retryAfterMs || SECOND_QUOTA_COOLDOWN_MS, SECOND_QUOTA_COOLDOWN_MS);
      }
      return Math.min(retryAfterMs || MAX_QUOTA_COOLDOWN_MS, MAX_QUOTA_COOLDOWN_MS);
    }

    if (status === 503) {
      const failCount = previous + 1;
      stats.modelFailures.set(failureKey, failCount);
      return Math.min(CAPACITY_COOLDOWN_MS * failCount, MAX_CAPACITY_COOLDOWN_MS);
    }

    stats.modelFailures.set(failureKey, previous + 1);
    return retryAfterMs || 60_000;
  }

  function longRemoteCooldownMs(status, payload) {
    const retryAfterMs = Math.max(0, Number(payload.retryAfterMs || 0));
    if (status === 503) {
      return Math.min(retryAfterMs || MAX_CAPACITY_COOLDOWN_MS, MAX_CAPACITY_COOLDOWN_MS);
    }
    return Math.min(retryAfterMs || SECOND_QUOTA_COOLDOWN_MS, MAX_QUOTA_COOLDOWN_MS);
  }

  function reportResult(req, res, payload) {
    if (!isAuthorized(req, payload, secret)) {
      totalErrors++;
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    const leaseId = String(payload.leaseId || '').trim();
    const lease = leases.get(leaseId);
    if (!lease) {
      log(`[remote-token] report ${leaseId || '-'} ignored: lease not found`);
      return sendJson(res, 200, { ok: true, ignored: true, reason: 'lease_not_found', status: getStatus() });
    }

    const status = Number(payload.status || 0);
    const modelKey = String(payload.modelKey || lease.modelKey || '').trim();
    verifyIntegrityHash(payload.integrityHash, lease.accessKeyId, log);
    const stats = ensureAccountStats(lease.accountId);
    stats.lastStatus = status;
    stats.lastUsedAt = Date.now();
    totalReports++;

    // ── Server-side token usage verification ──────────────────────────
    // When client reports a successful generation (status 200) but 0 tokens,
    // this is suspicious — a real successful generation always has tokens.
    // Estimate minimum usage from the request body size stored in the lease.
    const isSuccessfulGeneration = status >= 200 && status < 400 && lease.isGeneration;
    const reportedTotal = readTokenCount(payload.totalTokens) ||
      readTokenCount(payload.rawTotalTokens) ||
      (readTokenCount(payload.inputTokens) + readTokenCount(payload.outputTokens));
    let usageForBilling = {
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      cachedInputTokens: payload.cachedInputTokens,
      rawTotalTokens: payload.rawTotalTokens,
      totalTokens: payload.totalTokens,
    };
    if (isSuccessfulGeneration && reportedTotal <= 0) {
      // Estimate: ~1 token per 4 bytes of request body (conservative)
      const estimatedInputTokens = Math.max(100, Math.ceil((lease.requestBodyBytes || 0) / 4));
      // Assume at least a minimal output for a successful response
      const estimatedOutputTokens = Math.max(50, Math.ceil(estimatedInputTokens * 0.1));
      const estimatedTotal = estimatedInputTokens + estimatedOutputTokens;
      usageForBilling = {
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
        cachedInputTokens: 0,
        rawTotalTokens: estimatedTotal,
        totalTokens: estimatedTotal,
      };
      // Track suspicious reports per access key
      if (!lease._zeroTokenWarned) {
        lease._zeroTokenWarned = true;
        const keyRecord = findAccessKeyRecord(lease.accessKeyId);
        const keyLabel = keyRecord ? (keyRecord.label || keyRecord.id || lease.accessKeyId) : lease.accessKeyId;
        if (!keyRecord._suspiciousZeroTokenCount) keyRecord._suspiciousZeroTokenCount = 0;
        keyRecord._suspiciousZeroTokenCount++;
        log(
          `[remote-token] ⚠ SUSPICIOUS: key=${keyLabel} lease=${leaseId} reported 0 tokens on successful generation. ` +
          `Estimated ${estimatedTotal} tokens from ${lease.requestBodyBytes || 0}B request. ` +
          `Cumulative suspicious reports: ${keyRecord._suspiciousZeroTokenCount}`
        );
      }
    }
    recordAccessKeyUsage(lease.accessKeyId, status, usageForBilling, modelKey);
    const accessKeyRecord = refreshAccessKeySessionById(lease.accessKeyId, lease.accessKeySessionId, lease.clientId);
    // ── Accumulate per-account token usage ──
    const inputTk = readTokenCount(usageForBilling.inputTokens);
    const outputTk = readTokenCount(usageForBilling.outputTokens);
    const totalTk = readTokenCount(usageForBilling.totalTokens) || (inputTk + outputTk);
    stats.totalInputTokens = (stats.totalInputTokens || 0) + inputTk;
    stats.totalOutputTokens = (stats.totalOutputTokens || 0) + outputTk;
    stats.totalTokensUsed = (stats.totalTokensUsed || 0) + totalTk;
    ensureDailyReset();
    daily.tokensUsed += totalTk;
    debounceSaveAccountStats();

    stats.recentResults.push({ ok: status >= 200 && status < 400, status, at: stats.lastUsedAt });
    if (stats.recentResults.length > 50) stats.recentResults.splice(0, stats.recentResults.length - 50);

    if (status >= 200 && status < 400) {
      stats.successCount++;
      daily.successes++;
      reportEnterpriseResult(lease.email, true);
      stats.authFailures = 0;
      stats.locationFailures = 0;
      stats.lastSuccessAt = stats.lastUsedAt || Date.now();
      if (lease.probation && modelKey) {
        clearModelGate(lease.accountId, modelKey);
        log(`[remote-token] probation passed #${lease.accountId} model=${modelKey}`);
      }
      if (modelKey) {
        stats.modelFailures.delete(normalizeModelKey(modelKey));
      }
      if (modelKey && status >= 200 && status < 400) {
        clearModelPressure(modelKey);
      }
      quotaTracker.reportSuccess(lease.accountId, { modelKey });
    } else if (status === 503) {
      // 503 = transient server overload. Treat much lighter than 429.
      errorRateTracker.record(503, modelKey);
      stats.errorCount++;
      lease.released = true;
      clearClientModelAffinity(lease.accountId, lease.clientId, modelKey);
      const normalizedModel = normalizeModelKey(modelKey);
      const failureKey = normalizedModel || '(global)';
      const previousFailures = Number(stats.modelFailures.get(failureKey) || 0);
      const failureCount = previousFailures + 1;
      stats.modelFailures.set(failureKey, failureCount);
      // Record model pressure with sliding window (only activates at >= 8 unique accounts)
      if (modelKey) {
        const pressure = recordModelPressure(modelKey, status, lease.accountId);
        const activated = (pressure.uniqueAccountCount || 0) >= MODEL_PRESSURE_UNIQUE_THRESHOLD;
        log(
          `[remote-token] model pressure ${modelKey} total=${pressure.failCount} ` +
          `unique=${pressure.uniqueAccountCount}/${MODEL_PRESSURE_UNIQUE_THRESHOLD} ` +
          `activated=${activated} until=${activated ? new Date(Number(pressure.blockedUntil || 0)).toISOString() : 'n/a'}`
        );
      }
      // 503 cooldown: same short cooldown for both healthy and probation accounts
      // Probation 503 is "inconclusive", not a real failure
      const capacityCooldownMs = Math.min(CAPACITY_COOLDOWN_MS * failureCount, MAX_CAPACITY_COOLDOWN_MS);
      if (modelKey) {
        const gate = ensureModelGate(lease.accountId, modelKey);
        gate.state = 'cooling';
        gate.failCount = Math.max(Number(gate.failCount || 0) + 1, failureCount);
        gate.lastFailureAt = Date.now();
        gate.blockedUntil = Date.now() + capacityCooldownMs;
        gate.nextProbeAfter = gate.blockedUntil;
        gate.reason = 'capacity_transient';
      }
      log(
        `[remote-token] #${lease.accountId} 503 capacity failure=${failureCount} ` +
        `model=${modelKey || '-'} probation=${Boolean(lease.probation)} ` +
        `cooldown=${Math.ceil(capacityCooldownMs / 1000)}s (transient)`
      );
    } else if (status === 429) {
      errorRateTracker.record(429, modelKey);
      stats.errorCount++;
      stats.quota429Count++;
      reportEnterpriseResult(lease.email, false);
      lease.released = true;
      clearClientModelAffinity(lease.accountId, lease.clientId, modelKey);
      const normalizedModel = normalizeModelKey(modelKey);
      const failureKey = normalizedModel || '(global)';
      const previousFailures = Number(stats.modelFailures.get(failureKey) || 0);
      const failureCount = previousFailures + 1;
      stats.modelFailures.set(failureKey, failureCount);
      const reason = String(payload.reason || '') || 'quota';
      const probationFailure = Boolean(lease.probation);

      // ── 429 Model-Level Cooldown: use Google's retryAfterMs directly ──
      // Google tells us exactly when quota resets for this model.
      // We respect Google's time exactly without a hard cap.
      // If Google didn't provide a value, default to 1 min.
      const MIN_429_COOLDOWN_MS = 30 * 1000;
      const DEFAULT_429_COOLDOWN_MS = 60 * 1000;         // 1 min (no Google retryAfterMs)
      const googleRetryMs = Math.max(0, Number(payload.retryAfterMs || 0));
      const cooldownMs = googleRetryMs > 0
        ? Math.max(MIN_429_COOLDOWN_MS, googleRetryMs)
        : DEFAULT_429_COOLDOWN_MS;

      // Set per-model gate — account stays available for other models
      // Enterprise accounts skip cooling — the adaptive weight system handles them
      const isEnterprise = Boolean(getEnterpriseGroup(lease.email));
      if (modelKey && !isEnterprise) {
        const gate = ensureModelGate(lease.accountId, modelKey);
        gate.state = 'cooling';
        gate.failCount = Math.max(Number(gate.failCount || 0) + 1, failureCount);
        gate.lastFailureAt = Date.now();
        gate.blockedUntil = Date.now() + cooldownMs;
        gate.nextProbeAfter = gate.blockedUntil;
        gate.reason = reason;
      }

      // Only report account-level quota exhaustion for probation accounts
      // (they were already suspect). Healthy accounts just get the model gate.
      if (probationFailure) {
        quotaTracker.reportQuotaExhausted(lease.accountId, {
          reason,
          modelKey,
          retryAfterMs: cooldownMs,
          useSuggestedBlock: true,
        });
        log(
          `[remote-token] #${lease.accountId} 429 probation failure=${failureCount} ` +
          `model=${modelKey || '-'} cooldown=${Math.ceil(cooldownMs / 1000)}s ` +
          `(google=${googleRetryMs > 0 ? Math.ceil(googleRetryMs / 1000) + 's' : 'none'})`
        );
      } else {
        log(
          `[remote-token] #${lease.accountId} 429 model-cooldown failure=${failureCount} ` +
          `model=${modelKey || '-'} cooldown=${Math.ceil(cooldownMs / 1000)}s ` +
          `(google=${googleRetryMs > 0 ? Math.ceil(googleRetryMs / 1000) + 's' : 'none'}); other models ok`
        );
      }
    } else if (status === 400 && isLocationUnsupportedText(`${payload.errorText || ''} ${payload.message || ''}`)) {
      stats.errorCount++;
      stats.locationFailures = (stats.locationFailures || 0) + 1;
      lease.released = true;
      clearClientModelAffinity(lease.accountId, lease.clientId, modelKey);

      // Treat location unsupported as an endpoint/model probe failure, not as
      // account health. The same account can still succeed on other models or
      // via another client/egress, so never persist this into account exhausted
      // state or disable the account.
      const multiplier = Math.min(stats.locationFailures, 3);
      const cooldownMs = Math.min(15 * 60 * 1000, LOCATION_UNSUPPORTED_COOLDOWN_MS * multiplier);
      if (modelKey) {
        const gate = ensureModelGate(lease.accountId, modelKey);
        gate.state = 'cooling';
        gate.failCount = Math.max(Number(gate.failCount || 0) + 1, Number(stats.modelFailures.get(normalizeModelKey(modelKey)) || 1));
        gate.lastFailureAt = Date.now();
        gate.blockedUntil = Date.now() + cooldownMs;
        gate.nextProbeAfter = gate.blockedUntil;
        gate.reason = 'location_probe';
        stats.modelFailures.set(normalizeModelKey(modelKey), Number(stats.modelFailures.get(normalizeModelKey(modelKey)) || 0) + 1);
        log(
          `[remote-token] model location probe #${lease.accountId} ` +
          `model=${modelKey} failures=${stats.locationFailures} cooldown=${Math.round(cooldownMs / 60000)}m`
        );
      } else {
        log(
          `[remote-token] account location probe #${lease.accountId} ` +
          `failures=${stats.locationFailures}; account kept available`
        );
      }
    } else if (status === 401 || status === 403) {
      stats.errorCount++;
      lease.released = true;
      quotaTracker.reportError(lease.accountId);
      const errorText = String(payload.errorText || payload.message || '');
      const isVerification = isVerificationChallengeText(errorText);
      stats.authFailures = (stats.authFailures || 0) + 1;
      const lastSuccessAt = Number(stats.lastSuccessAt || 0);
      const hasRecentSuccess = lastSuccessAt > 0 && Date.now() - lastSuccessAt <= RECENT_SUCCESS_GRACE_MS;
      const shouldQuarantineVerification =
        isVerification &&
        !hasRecentSuccess &&
        stats.authFailures >= VERIFICATION_FAILURES_BEFORE_QUARANTINE;

      if (shouldQuarantineVerification) {
        const multiplier = Math.min(Math.max(1, stats.authFailures - VERIFICATION_FAILURES_BEFORE_QUARANTINE + 1), 6);
        quarantineAccount(lease.accountId, 'phone_verification_required', PHONE_VERIFICATION_COOLDOWN_MS * multiplier);
      } else if (!isVerification && stats.authFailures >= VERIFICATION_FAILURES_BEFORE_QUARANTINE) {
        const multiplier = Math.min(Math.max(1, stats.authFailures - VERIFICATION_FAILURES_BEFORE_QUARANTINE + 1), 6);
        quarantineAccount(lease.accountId, 'auth_forbidden', AUTH_FAILURE_COOLDOWN_MS * multiplier);
      } else {
        clearClientModelAffinity(lease.accountId, lease.clientId, modelKey);
        if (modelKey) {
          blockAccountForModel(
            lease.accountId,
            modelKey,
            isVerification ? 'verification_probe' : 'auth_probe',
            Math.max(60_000, Number(payload.retryAfterMs || 0) || 0)
          );
        }
        log(
          `[remote-token] delayed auth quarantine #${lease.accountId} ` +
          `status=${status} verification=${isVerification ? 'yes' : 'no'} ` +
          `recentSuccess=${hasRecentSuccess ? 'yes' : 'no'} failures=${stats.authFailures}`
        );
      }
    } else if (status >= 400) {
      stats.errorCount++;
    }

    log(`[remote-token] report ${leaseId} status=${status || 'n/a'} account=#${lease.accountId}`);
    debounceSaveModelGates();
    sendJson(res, 200, {
      ok: true,
      accessKeyStatus: accessKeyPublicStatus(accessKeyRecord),
      status: getStatus(),
    });
  }

  function sanitizeQuotaGroups(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 80).map((group, index) => ({
      key: String(group?.key || `quota-${index}`),
      label: String(group?.label || ''),
      fraction: group?.fraction == null ? null : Number(group.fraction),
      percent: group?.percent == null ? null : Number(group.percent),
      hasSnapshotPercent: Boolean(group?.hasSnapshotPercent),
      resetTime: String(group?.resetTime || ''),
      provider: String(group?.provider || ''),
      sortOrder: Number(group?.sortOrder || index),
      models: Array.isArray(group?.models) ? group.models.slice(0, 200).map((item) => String(item)) : [],
    }));
  }

  function quotaStatusFromGroups(groups) {
    const percents = groups
      .map((group) => Number(group.percent))
      .filter((value) => Number.isFinite(value));
    if (percents.length === 0) return { label: '额度未知', tone: 'warn', blockedCount: 0 };
    const min = Math.min(...percents);
    const blockedCount = groups.filter((group) => Number(group.percent) <= 0).length;
    if (min <= 0) return { label: '部分额度耗尽', tone: 'danger', blockedCount };
    if (min <= 20) return { label: '额度偏低', tone: 'warn', blockedCount };
    return { label: '额度正常', tone: 'ok', blockedCount };
  }

  function reportQuotaSnapshot(req, res, payload) {
    if (!isAuthorized(req, payload, secret)) {
      totalErrors++;
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    const leaseId = String(payload.leaseId || '').trim();
    const lease = leases.get(leaseId);
    if (!lease) {
      totalErrors++;
      return sendJson(res, 404, { ok: false, error: 'Lease not found' });
    }

    const accountId = Number(payload.accountId || lease.accountId);
    if (accountId !== Number(lease.accountId)) {
      totalErrors++;
      return sendJson(res, 403, { ok: false, error: 'Lease/account mismatch' });
    }

    const projectId = String(payload.projectId || lease.projectId || '').trim();
    if (projectId && String(lease.projectId || '') !== projectId) {
      totalErrors++;
      return sendJson(res, 403, { ok: false, error: 'Lease/project mismatch' });
    }

    try {
      const quotaGroups = sanitizeQuotaGroups(payload.quotaGroups);
      const quotaRefreshedAt = String(payload.quotaRefreshedAt || new Date().toISOString());
      const status = quotaStatusFromGroups(quotaGroups);
      const data = readJsonFile(accountsFilePath);
      const accounts = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [];
      const account = accounts.find((item) => Number(item?.id) === accountId);
      if (!account) {
        totalErrors++;
        return sendJson(res, 404, { ok: false, error: 'Account not found' });
      }

      account.quotaGroups = quotaGroups;
      account.quotaRefreshedAt = quotaRefreshedAt;
      account.quotaLiveBlockedCount = status.blockedCount;
      account.accountStatusLabel = status.label;
      account.accountStatusTone = status.tone;
      account.lastQuotaSnapshotReason = String(payload.reason || '');
      if (quotaGroups.some((group) => group.resetTime)) {
        account.accountResetTime = quotaGroups.find((group) => group.resetTime)?.resetTime || '';
      }

      writeJsonFile(accountsFilePath, data);
      tokenManager.loadAccounts();
      if (payload.modelsJson && typeof tokenManager.updateProjectModels === 'function') {
        try {
          tokenManager.updateProjectModels(accountId, String(payload.modelsJson));
        } catch (error) {
          log(`[remote-token] quota model cache update failed #${accountId}: ${error.message}`);
        }
      }

      const stats = ensureAccountStats(accountId);
      stats.lastQuotaSnapshotAt = Date.now();
      stats.quotaRefreshedAt = quotaRefreshedAt;
      stats.quotaGroups = quotaGroups;
      stats.quotaLiveBlockedCount = status.blockedCount;
      log(`[remote-token] quota snapshot #${accountId} groups=${quotaGroups.length} reason=${payload.reason || '-'}`);
      sendJson(res, 200, { ok: true, quotaGroups: quotaGroups.length, status: getStatus() });
    } catch (error) {
      totalErrors++;
      lastError = error.message;
      log(`[remote-token] quota snapshot error: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  function getStatus() {
    cleanupExpiredLeases();
    const activeLeaseCounts = {};
    for (const lease of leases.values()) {
      if (lease.released) continue;
      activeLeaseCounts[lease.accountId] = (activeLeaseCounts[lease.accountId] || 0) + 1;
    }
    const now = Date.now();
    const accessKeys = readAccessKeys().keys.map((item) => {
      pruneUsageEvents(item, now);
      const recentTokens = recentTokenUsage(item, now);
      const tokensLimit = tokenWindowLimit(item);
      const resetMs = tokenWindowResetMs(item, now);
      return {
        id: item.id,
        name: item.name || '',
        status: item.status || 'active',
        durationMs: Number(item.durationMs || 0),
        firstUsedAt: item.firstUsedAt || '',
        expiresAt: keyExpiresAt(item),
        totalRequests: Number(item.totalRequests || 0),
        recentWindowRequests: (item.usageEvents || []).length,
        windowMs: Number(item.windowMs || DEFAULT_KEY_WINDOW_MS),
        windowLimit: Number(item.windowLimit || 0),
        totalInputTokens: Number(item.totalInputTokens || 0),
        totalOutputTokens: Number(item.totalOutputTokens || 0),
        totalCachedInputTokens: Number(item.totalCachedInputTokens || 0),
        totalRawTokensUsed: Number(item.totalRawTokensUsed || 0),
        totalTokensUsed: Number(item.totalTokensUsed || 0),
        recentWindowInputTokens: recentTokens.inputTokens,
        recentWindowOutputTokens: recentTokens.outputTokens,
        recentWindowCachedInputTokens: recentTokens.cachedInputTokens,
        recentWindowRawTokens: recentTokens.rawTotalTokens,
        recentWindowRawTokens: recentTokens.rawTotalTokens,
        recentWindowTokensUsed: recentTokens.totalTokens,
        opusTokensUsed: recentTokens.opusEffectiveTokens,
        opusTokenLimit: tokensLimit,
        geminiTokensUsed: recentTokens.geminiEffectiveTokens,
        geminiTokenLimit: tokensLimit * 5,
        recentWindowResetMs: resetMs,
        tokenWindowLimit: tokensLimit,
        tokenWindowRemaining: tokensLimit > 0 ? Math.max(0, tokensLimit - recentTokens.totalTokens) : 0,
        tokenWindowStartedAt: Number(item.windowStartedAt || 0) > 0 ? new Date(item.windowStartedAt).toISOString() : '',
        tokenWindowResetMs: resetMs,
        tokenWindowResetAt: resetMs > 0 ? new Date(now + resetMs).toISOString() : '',
        lastUsedAt: item.lastUsedAt || '',
        createdAt: item.createdAt || '',
        hasActiveSession: Boolean(item.activeSessionId && !isAccessKeySessionExpired(item, now)),
        sessionClientId: item.sessionClientId || '',
        sessionStartedAt: item.sessionStartedAt || '',
        sessionLastSeenAt: item.sessionLastSeenAt || '',
        sessionExpiresAt: item.sessionExpiresAt || '',
        sessionTtlMs: accessKeySessionTtlMs(item),
      };
    });
    return {
      running: true,
      mode: 'remote-token-server',
      host,
      port,
      hasSecret: false,
      authMode: 'access-key',
      minClientVersion: MIN_CLIENT_VERSION,
      upgradeUrl: CLIENT_UPGRADE_URL,
      totalLeases,
      totalReports,
      totalErrors,
      lastError,
      activeLeases: leases.size,
      maxConcurrentPerAccount,
      affinityClients: clientAffinity.size,
      accessKeys,
      scheduler: {
        leaseTtlMs,
        affinityTtlMs,
        activeLeaseCounts,
        accountStats: serializeAccountStats(),
        modelGates: serializeModelGates(now),
        modelPressure: serializeModelPressure(now),
      },
      quota: quotaTracker.getStatus(),
      daily: (() => { ensureDailyReset(); return { ...daily }; })(),
      enterpriseProbe: Object.fromEntries(
        Object.entries(enterpriseGroups).map(([group, g]) => {
          ensureEnterpriseCycle(group);
          const total = g.successes + g.failures;
          return [group, {
            weight: g.weight,
            successes: g.successes,
            failures: g.failures,
            rate: total > 0 ? Math.round(g.successes / total * 100) : null,
            emergency: g.emergency,
            cycleMinutesLeft: Math.max(0, Math.round((ENTERPRISE_CYCLE_MS - (Date.now() - g.cycleStart)) / 60000)),
          }];
        })
      ),
    };
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/health')) {
      return sendJson(res, 200, getStatus());
    }

    if (req.method !== 'POST') {
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    readBody(req)
      .then((payload) => {
        if (url.pathname === '/lease-token') return leaseToken(req, res, payload);
        if (url.pathname === '/report-result') return reportResult(req, res, payload);
        if (url.pathname === '/report-quota-snapshot') return reportQuotaSnapshot(req, res, payload);
        if (url.pathname === '/reload-accounts') {
          tokenManager.loadAccounts();
          return sendJson(res, 200, { ok: true, status: getStatus() });
        }
        if (url.pathname === '/unblock-location') {
          const accounts = typeof tokenManager.listAccounts === 'function' ? tokenManager.listAccounts() : [];
          let unblocked = 0;
          for (const acctSummary of accounts) {
            const account = tokenManager.getAccount(acctSummary.id);
            if (!account) continue;
            const reason = String(account.quotaStatusReason || '');
            const isLocationBlocked = reason === 'location_unsupported' || reason === 'location_permanent_ban';
            // Use acctSummary.blockedModels (array from listAccounts) not account's internal Map
            const hasLocationModels = Array.isArray(acctSummary.blockedModels)
              ? acctSummary.blockedModels.some(m => m.reason === 'location_unsupported')
              : false;

            if (isLocationBlocked || hasLocationModels) {
              // Re-enable permanently banned accounts
              if (account.enabled === false && reason === 'location_permanent_ban') {
                account.enabled = true;
              }
              // Use resetQuotaStatus to properly clear the internal blockedModels Map
              if (typeof tokenManager.resetQuotaStatus === 'function') {
                tokenManager.resetQuotaStatus(acctSummary.id);
              } else {
                account.quotaStatus = 'ok';
                account.quotaStatusReason = '';
                account.blockedUntil = 0;
                account.exhaustedUntil = 0;
                account.blockedModels = [];
              }
              unblocked++;
            }
            // Reset location failure counters in scheduler stats
            const stats = ensureAccountStats(acctSummary.id);
            stats.locationFailures = 0;
            // Clear location model gates for this account
            for (const [key, gate] of modelGate.entries()) {
              if (gate.accountId === acctSummary.id && gate.reason === 'location_unsupported') {
                modelGate.delete(key);
              }
            }
          }
          if (typeof tokenManager.saveAccounts === 'function') tokenManager.saveAccounts();
          debounceSaveModelGates();
          log(`[remote-token] unblock-location: unblocked ${unblocked} accounts`);
          return sendJson(res, 200, { ok: true, unblocked });
        }
        if (url.pathname === '/unblock-accounts') {
          const ids = Array.isArray(payload.accountIds)
            ? payload.accountIds.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0)
            : [];
          if (!ids.length) {
            return sendJson(res, 400, { ok: false, error: 'accountIds array is required' });
          }
          const idSet = new Set(ids);
          const accounts = typeof tokenManager.listAccounts === 'function' ? tokenManager.listAccounts() : [];
          let unblocked = 0;
          for (const acctSummary of accounts) {
            if (!idSet.has(Number(acctSummary.id))) continue;
            const account = tokenManager.getAccount(acctSummary.id);
            if (!account) continue;
            // Re-enable if disabled
            if (account.enabled === false) {
              account.enabled = true;
            }
            // Reset quota status
            if (typeof tokenManager.resetQuotaStatus === 'function') {
              tokenManager.resetQuotaStatus(acctSummary.id);
            } else {
              account.quotaStatus = 'ok';
              account.quotaStatusReason = '';
              account.blockedUntil = 0;
              account.exhaustedUntil = 0;
              account.blockedModels = [];
            }
            // Reset scheduler stats
            const stats = ensureAccountStats(acctSummary.id);
            stats.locationFailures = 0;
            stats.authFailures = 0;
            stats.errorCount = 0;
            stats.modelFailures = stats.modelFailures || new Map();
            stats.modelFailures.clear();
            // Clear model gates for this account
            for (const [key, gate] of modelGate.entries()) {
              if (gate.accountId === acctSummary.id) {
                modelGate.delete(key);
              }
            }
            unblocked++;
            log(`[remote-token] unblock-accounts: unblocked #${acctSummary.id} ${maskEmail(account.email)}`);
          }
          if (typeof tokenManager.saveAccounts === 'function') tokenManager.saveAccounts();
          debounceSaveModelGates();
          log(`[remote-token] unblock-accounts: unblocked ${unblocked}/${ids.length} accounts`);
          return sendJson(res, 200, { ok: true, unblocked, requested: ids.length });
        }
        if (url.pathname === '/toggle-account') {
          const accountId = Number(payload.accountId);
          const enabled = payload.enabled;
          if (!Number.isFinite(accountId) || accountId <= 0) {
            return sendJson(res, 400, { ok: false, error: 'accountId is required' });
          }
          if (typeof enabled !== 'boolean') {
            return sendJson(res, 400, { ok: false, error: 'enabled (boolean) is required' });
          }
          const account = tokenManager.getAccount(accountId);
          if (!account) {
            return sendJson(res, 404, { ok: false, error: `Account #${accountId} not found` });
          }
          account.enabled = enabled;
          if (enabled) {
            // When re-enabling, also reset quota status to give it a fresh start
            if (typeof tokenManager.resetQuotaStatus === 'function') {
              tokenManager.resetQuotaStatus(accountId);
            } else {
              account.quotaStatus = 'ok';
              account.quotaStatusReason = '';
              account.blockedUntil = 0;
              account.exhaustedUntil = 0;
            }
            const stats = ensureAccountStats(accountId);
            stats.locationFailures = 0;
            stats.authFailures = 0;
            stats.errorCount = 0;
            // Clear model gates
            for (const [key, gate] of modelGate.entries()) {
              if (gate.accountId === accountId) modelGate.delete(key);
            }
          }
          if (typeof tokenManager.saveAccounts === 'function') tokenManager.saveAccounts();
          debounceSaveModelGates();
          log(`[remote-token] toggle-account: #${accountId} ${maskEmail(account.email)} → ${enabled ? 'ENABLED' : 'DISABLED'}`);
          return sendJson(res, 200, { ok: true, accountId, enabled, email: maskEmail(account.email) });
        }
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: error.message }));
  });

  let autoRecheckTimer = null;

  return {
    start() {
      server.listen(port, host, () => {
        log(`[remote-token] listening on http://${host}:${port}`);
        log(`[remote-token] accounts=${path.resolve(accountsFilePath)}`);
      });
      sweepAutoRecheckCandidates();
      autoRecheckTimer = setInterval(sweepAutoRecheckCandidates, AUTO_RECHECK_SWEEP_MS);
      if (typeof autoRecheckTimer.unref === 'function') autoRecheckTimer.unref();
      return server;
    },
    stop() {
      if (autoRecheckTimer) {
        clearInterval(autoRecheckTimer);
        autoRecheckTimer = null;
      }
      quotaTracker.destroy();
      server.close();
    },
    getStatus,
  };
}

function main() {
  const fileConfig = readJsonFile(paths.configPath());
  const remoteConfig = fileConfig.remoteTokenServer || {};
  const logFilePath = path.join(paths.DATA_DIR, 'logs', 'remote-token-server.log');
  const logger = createLogger({ filePath: logFilePath });
  const config = {
    host: process.env.REMOTE_TOKEN_HOST || remoteConfig.host || '0.0.0.0',
    port: Number(process.env.REMOTE_TOKEN_PORT || remoteConfig.port || 60700),
    secret: String(process.env.REMOTE_TOKEN_SECRET || remoteConfig.secret || remoteConfig.tokenServerSecret || ''),
    accountsFilePath: remoteConfig.accountsFilePath || fileConfig.accountsFilePath || paths.accountsPath(),
    cloudEndpoint: remoteConfig.googleCloudEndpoint || fileConfig.googleCloudEndpoint,
    cooldownMs: remoteConfig.cooldownMs || fileConfig.tokenProxyCooldownMs || 60000,
    leaseTtlMs: remoteConfig.leaseTtlMs || DEFAULT_LEASE_TTL_MS,
    affinityTtlMs: remoteConfig.affinityTtlMs || DEFAULT_AFFINITY_TTL_MS,
    maxConcurrentPerAccount: remoteConfig.maxConcurrentPerAccount || DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
    log: logger.log,
  };

  console.log('=== BCAI Remote Token Server ===');
  console.log(`Listen:   ${config.host}:${config.port}`);
  console.log(`Data:     ${paths.DATA_DIR}`);
  console.log(`Accounts: ${path.resolve(config.accountsFilePath)}`);
  console.log(`Secret:   ${config.secret ? '(configured)' : '(not configured)'}`);
  console.log(`Log:      ${logFilePath}`);

  const service = createRemoteTokenServer(config);
  service.start().on('error', (error) => {
    config.log(`[fatal] server error: ${error.message}`);
    process.exit(1);
  });

  process.on('SIGINT', () => { service.stop(); logger.destroy(); process.exit(0); });
  process.on('SIGTERM', () => { service.stop(); logger.destroy(); process.exit(0); });
}

if (require.main === module) {
  main();
}

module.exports = { createRemoteTokenServer, main };
