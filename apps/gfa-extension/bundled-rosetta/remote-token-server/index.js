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

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    text.includes('verify your info to continue') ||
    text.includes('google needs to verify') ||
    text.includes('verify some info about your device or phone number') ||
    text.includes('scan the qr code with your phone') ||
    text.includes('account to continue using antigravity') ||
    text.includes('validation_required') ||
    text.includes('"reason":"validation_required"') ||
    text.includes('"reason": "validation_required"') ||
    text.includes('validation_url')
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
const ACCESS_KEYS_PATH = path.join(paths.DATA_DIR, 'access-keys.json');

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

function keyExpiresAt(record) {
  if (!record?.firstUsedAt) return '';
  const durationMs = Number(record.durationMs || 0);
  if (!durationMs) return '';
  return new Date(Date.parse(record.firstUsedAt) + durationMs).toISOString();
}

function pruneUsageEvents(record, now = Date.now()) {
  const windowMs = Number(record.windowMs || DEFAULT_KEY_WINDOW_MS);
  const cutoff = now - windowMs;
  record.usageEvents = (Array.isArray(record.usageEvents) ? record.usageEvents : [])
    .filter((item) => Number(item?.at || 0) >= cutoff);
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
  const limit = Number(record.windowLimit || DEFAULT_KEY_WINDOW_LIMIT);
  if (options.enforceLimit && limit > 0 && record.usageEvents.length >= limit) {
    writeAccessKeys(data);
    return { key, record: null, error: `Access key rate limit exceeded (${limit}/5h)` };
  }
  if (options.activate) writeAccessKeys(data);
  return { key, record, data };
}

function recordAccessKeyUsage(cardId, status) {
  if (!cardId) return;
  const data = readAccessKeys();
  const record = data.keys.find((item) => item.id === cardId);
  if (!record) return;
  const now = Date.now();
  pruneUsageEvents(record, now);
  record.totalRequests = Number(record.totalRequests || 0) + 1;
  record.lastUsedAt = new Date(now).toISOString();
  record.usageEvents.push({ at: now, status: Number(status || 0) });
  writeAccessKeys(data);
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
    windowLimit: Number(record.windowLimit || DEFAULT_KEY_WINDOW_LIMIT),
    windowMs: Number(record.windowMs || DEFAULT_KEY_WINDOW_MS),
    lastUsedAt: record.lastUsedAt || '',
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
  let totalLeases = 0;
  let totalReports = 0;
  let totalErrors = 0;
  let lastError = null;

  function ensureAccountStats(accountId) {
    const id = Number(accountId);
    if (!accountStats.has(id)) {
      accountStats.set(id, {
        successCount: 0,
        errorCount: 0,
        quota429Count: 0,
        recentResults: [],
        totalLeases: 0,
        lastUsedAt: 0,
        lastStatus: 0,
      });
    }
    return accountStats.get(id);
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

  function quarantineAccount(accountId, reason, durationMs = 24 * 60 * 60 * 1000) {
    const account = tokenManager.getAccount(accountId);
    if (!account) return false;
    const blockedUntil = Date.now() + Math.max(60_000, Number(durationMs) || 0);
    clearAccountAffinityAndLeases(accountId);
    tokenManager.markExhausted(accountId, {
      reason: reason || 'verification_required',
      blockedUntil,
    });
    log(`[remote-token] quarantined #${accountId} ${maskEmail(account.email)} reason=${reason || 'verification_required'} until=${new Date(blockedUntil).toISOString()}`);
    return true;
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

  function accountWeight(account) {
    const configured = Number(account.remoteWeight ?? account.weight ?? 0);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const plan = String(account.planType || '').toLowerCase();
    if (plan.includes('ultra')) return 3;
    if (plan.includes('premium') || plan.includes('pro')) return 2;
    return 1;
  }

  function scoreAccount(account, options) {
    const now = options.now;
    const stats = ensureAccountStats(account.id);
    const totalActive = activeLeaseCount(account.id, '', now);
    const modelActive = activeLeaseCount(account.id, options.modelKey, now);
    const affinity = options.preferredAccountId === account.id ? -500 : 0;
    const recentlyUsedMs = stats.lastUsedAt ? Math.max(0, 60_000 - (now - stats.lastUsedAt)) : 0;
    const recentUsePenalty = Math.ceil(recentlyUsedMs / 1000);

    return (
      totalActive * 1000 +
      modelActive * 250 +
      stats.quota429Count * 80 +
      stats.errorCount * 30 +
      recentUsePenalty -
      accountWeight(account) * 50 +
      affinity
    );
  }

  function selectLeaseCandidate(accounts, options) {
    const now = options.now;
    const limit = Math.max(1, Number(maxConcurrentPerAccount) || DEFAULT_MAX_CONCURRENT_PER_ACCOUNT);
    const candidates = accounts.filter((account) =>
      account.enabled &&
      account.projectId &&
      account.quotaStatus !== 'error' &&
      account.quotaStatus !== 'exhausted' &&
      !isAccountBlockedForModel(account, options.modelKey, now)
    );

    if (candidates.length === 0) return null;

    const underLimit = candidates.filter((account) => activeLeaseCount(account.id, '', now) < limit);
    const pool = underLimit.length > 0 ? underLimit : candidates;
    return pool
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
      )[0].account;
  }

  async function getLeaseCandidateToken(modelKey, clientId) {
    cleanupExpiredLeases();
    tokenManager.loadAccounts();
    const status = quotaTracker.getStatus();
    const accounts = tokenManager.listAccounts();
    const now = Date.now();
    const affinity = clientId ? clientAffinity.get(affinityKey(clientId, modelKey)) : null;
    const preferredAccountId = affinity && Number(affinity.expiresAt || 0) > now
      ? Number(affinity.accountId)
      : Number(status.activeAccountId || 0);
    const selected = selectLeaseCandidate(accounts, {
      now,
      modelKey,
      clientId,
      preferredAccountId,
    });

    const ordered = selected
      ? [selected, ...accounts.filter((account) => account.id !== selected.id)]
      : accounts;

    let lastTokenError = null;
    for (const account of ordered) {
      if (
        !account.enabled ||
        !account.projectId ||
        account.quotaStatus === 'error' ||
        account.quotaStatus === 'exhausted' ||
        isAccountBlockedForModel(account, modelKey, now)
      ) {
        continue;
      }
      try {
        const token = await tokenManager.getAccessToken(account.id);
        quotaTracker.setActiveAccount(account.id, 'remote_lease');
        const stats = ensureAccountStats(account.id);
        stats.totalLeases++;
        stats.lastUsedAt = Date.now();
        return {
          token,
          accountId: account.id,
          email: account.email,
          projectId: account.projectId,
          modelKey,
        };
      } catch (error) {
        lastTokenError = error;
        log(`[remote-token] token refresh failed #${account.id}: ${error.message}`);
      }
    }

    if (lastTokenError) throw lastTokenError;
    throw new Error('No enabled account with projectId is available.');
  }

  async function leaseToken(req, res, payload) {
    const auth = resolveAccessKey(req, payload, { activate: false, enforceLimit: true });
    if (!auth.record) {
      totalErrors++;
      return sendJson(res, 401, { ok: false, error: auth.error || 'Unauthorized' });
    }

    try {
      const modelKey = String(payload.modelKey || payload.model || '').trim();
      const clientId = String(payload.clientId || payload.client || '').trim();
      const tokenInfo = await getLeaseCandidateToken(modelKey, clientId);
      if (!tokenInfo.projectId) {
        throw new Error('No account with projectId is available.');
      }

      const leaseId = crypto.randomUUID();
      const ttlMs = Math.max(60_000, Number(leaseTtlMs) || DEFAULT_LEASE_TTL_MS);
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
        createdAt: Date.now(),
        expiresAt,
        released: false,
      });
      if (clientId) {
        clientAffinity.set(affinityKey(clientId, modelKey), {
          accountId: tokenInfo.accountId,
          expiresAt: Date.now() + Math.max(60_000, Number(affinityTtlMs) || DEFAULT_AFFINITY_TTL_MS),
        });
      }
      totalLeases++;
      const accessKeyRecord = activateAccessKey(auth.record.id) || auth.record;

      log(`[remote-token] lease ${leaseId} -> #${tokenInfo.accountId} ${maskEmail(tokenInfo.email)} client=${clientId || '-'} active=${activeLeaseCount(tokenInfo.accountId)} project=${tokenInfo.projectId}`);
      sendJson(res, 200, {
        ok: true,
        leaseId,
        accessKeyStatus: accessKeyPublicStatus(accessKeyRecord),
        accountId: tokenInfo.accountId,
        emailHint: maskEmail(tokenInfo.email),
        accessToken: tokenInfo.token,
        projectId: tokenInfo.projectId,
        expiresAt,
      });
    } catch (error) {
      totalErrors++;
      lastError = error.message;
      log(`[remote-token] lease error: ${error.message}`);
      sendJson(res, 503, { ok: false, error: error.message });
    }
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
    const stats = ensureAccountStats(lease.accountId);
    stats.lastStatus = status;
    stats.lastUsedAt = Date.now();
    totalReports++;
    recordAccessKeyUsage(lease.accessKeyId, status);
    stats.recentResults.push({ ok: status >= 200 && status < 400, status, at: stats.lastUsedAt });
    if (stats.recentResults.length > 50) stats.recentResults.splice(0, stats.recentResults.length - 50);

    if (status >= 200 && status < 400) {
      stats.successCount++;
      quotaTracker.reportSuccess(lease.accountId, { modelKey });
    } else if (status === 429 || status === 503) {
      stats.errorCount++;
      stats.quota429Count++;
      lease.released = true;
      for (const [key, value] of clientAffinity.entries()) {
        if (
          Number(value?.accountId || 0) === Number(lease.accountId) &&
          key === affinityKey(lease.clientId, modelKey)
        ) {
          clientAffinity.delete(key);
        }
      }
      quotaTracker.reportQuotaExhausted(lease.accountId, {
        reason: String(payload.reason || '') || (status === 503 ? 'capacity' : 'quota'),
        modelKey,
        retryAfterMs: Number(payload.retryAfterMs || 0),
      });
    } else if (status === 401 || status === 403) {
      stats.errorCount++;
      lease.released = true;
      quotaTracker.reportError(lease.accountId);
      const errorText = String(payload.errorText || payload.message || '');
      if (isVerificationChallengeText(errorText)) {
        quarantineAccount(lease.accountId, 'verification_required');
      } else {
        clearAccountAffinityAndLeases(lease.accountId);
      }
    } else if (status >= 400) {
      stats.errorCount++;
    }

    log(`[remote-token] report ${leaseId} status=${status || 'n/a'} account=#${lease.accountId}`);
    sendJson(res, 200, { ok: true, status: getStatus() });
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
        windowLimit: Number(item.windowLimit || DEFAULT_KEY_WINDOW_LIMIT),
        lastUsedAt: item.lastUsedAt || '',
        createdAt: item.createdAt || '',
      };
    });
    return {
      running: true,
      mode: 'remote-token-server',
      host,
      port,
      hasSecret: false,
      authMode: 'access-key',
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
        accountStats: Object.fromEntries(accountStats.entries()),
      },
      quota: quotaTracker.getStatus(),
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
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: error.message }));
  });

  return {
    start() {
      server.listen(port, host, () => {
        log(`[remote-token] listening on http://${host}:${port}`);
        log(`[remote-token] accounts=${path.resolve(accountsFilePath)}`);
      });
      return server;
    },
    stop() {
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
