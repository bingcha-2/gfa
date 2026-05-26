'use strict';

/**
 * Client-side token passthrough proxy for "临时续杯".
 *
 * It runs on the customer machine. Instead of reading local accounts.json, it
 * leases an accessToken + projectId from the owner's Remote Token Server, then
 * forwards Antigravity Cloud Code requests to Google's endpoint in the same
 * style as the local Token Proxy.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');

const {
  DEFAULT_CLOUD_ENDPOINT,
  createTokenUsageCapture,
  decodeErrorBody,
  extractModelKeyFromBody,
  extractTokenUsageFromText,
  prepareForwardRequest,
  sanitizeProxyResponseHeaders,
} = require('../token-proxy/token-proxy');

const CLIENT_VERSION_FALLBACK = '4.0.2';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.setTimeout(60000, () => reject(new Error('Request read timeout')));
  });
}

function fingerprintSecret(secret) {
  const value = String(secret || '').trim();
  if (!value) return '(none)';
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)} len=${value.length}`;
  return `${value.slice(0, 6)}***${value.slice(-4)} len=${value.length}`;
}

function safeRemoteUrl(url) {
  try {
    const target = new URL(url);
    return `${target.protocol}//${target.host}${target.pathname}`;
  } catch {
    return String(url || '(invalid)');
  }
}

function postJson(url, payload, secret, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    };
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
      headers['X-Token-Server-Secret'] = secret;
    }

    const req = transport.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if ((res.statusCode || 500) >= 400 || parsed.ok === false) {
          const message = parsed.error || parsed.message || `HTTP ${res.statusCode}`;
          const error = new Error(message);
          error.statusCode = res.statusCode || 0;
          error.responseBody = raw.slice(0, 500);
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Token server timeout')));
    req.write(body);
    req.end();
  });
}

function readJsonFile(filePath) {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, value) {
  if (!filePath) return;
  fs.writeFileSync(filePath, `${JSON.stringify(value || {}, null, 2)}\n`, 'utf8');
}

function joinUrl(base, urlPath) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(urlPath || '').replace(/^\/+/, '')}`;
}

function shouldRefreshLease(lease) {
  if (!lease || !lease.accessToken || !lease.projectId) return true;
  const expiresAt = Date.parse(lease.expiresAt || '');
  if (!Number.isFinite(expiresAt)) {
    // No expiry info from Token Server — use default 45min TTL
    const leasedAt = Number(lease._leasedAt) || 0;
    return leasedAt > 0 ? Date.now() > leasedAt + 45 * 60 * 1000 : true;
  }
  return expiresAt < Date.now() + 60 * 1000;
}

function normalizeRemainingFraction(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function modelDisplayName(modelKey, modelData) {
  const name = String(modelData?.displayName || modelData?.name || modelKey || '').trim();
  return name.replace(/^models\//, '') || 'unknown';
}

function providerSortOrder(provider) {
  const value = String(provider || '').toLowerCase();
  if (value.includes('anthropic') || value.includes('claude')) return 10;
  if (value.includes('google') || value.includes('gemini')) return 20;
  if (value.includes('openai') || value.includes('gpt')) return 30;
  return 90;
}

function summarizeQuotaModels(modelsPayload) {
  const models = modelsPayload && typeof modelsPayload === 'object' ? modelsPayload.models : null;
  if (!models || typeof models !== 'object') return [];

  const groupsByBucket = new Map();
  for (const [modelKey, modelData] of Object.entries(models)) {
    if (!modelData || typeof modelData !== 'object') continue;
    const quotaInfo = modelData.quotaInfo || {};
    const fraction = normalizeRemainingFraction(quotaInfo.remainingFraction);
    const resetTime = String(quotaInfo.resetTime || quotaInfo.resetTimestamp || '').trim();
    if (fraction == null && !resetTime) continue;

    const percent = fraction == null ? null : Math.round(fraction * 100);
    const provider = String(modelData.apiProvider || modelData.provider || '').trim() || 'unknown';
    const bucket = `${provider}:${percent == null ? 'unknown' : percent}:${resetTime || 'no-reset'}`;
    if (!groupsByBucket.has(bucket)) {
      groupsByBucket.set(bucket, {
        key: bucket,
        label: percent == null ? '额度未知' : `剩余 ${percent}%`,
        fraction,
        percent,
        hasSnapshotPercent: percent != null,
        resetTime,
        provider,
        sortOrder: providerSortOrder(provider),
        models: [],
      });
    }
    groupsByBucket.get(bucket).models.push(modelDisplayName(modelKey, modelData));
  }

  return Array.from(groupsByBucket.values())
    .map((group) => ({ ...group, models: group.models.sort() }))
    .sort((a, b) => a.sortOrder - b.sortOrder || (b.percent ?? -1) - (a.percent ?? -1) || a.label.localeCompare(b.label));
}

function createTokenPassthroughServer(config) {
  const proxyPort = Number(config.proxyPort || 60670);
  const statusPort = Number(config.statusPort || 60681);
  const tokenServerUrl = String(config.tokenServerUrl || '').replace(/\/+$/, '');
  const tokenServerSecret = String(config.tokenServerSecret || '');
  const configPath = String(config.configPath || '');
  const cloudEndpoint = String(config.cloudEndpoint || DEFAULT_CLOUD_ENDPOINT).replace(/\/+$/, '');
  const clientId = String(config.clientId || process.env.BCAI_RELAY_CLIENT_ID || '').trim()
    || `relay-${crypto.randomUUID()}`;
  const clientVersion = String(config.clientVersion || process.env.BCAI_EXTENSION_VERSION || CLIENT_VERSION_FALLBACK).trim();
  const clientDistribution = String(config.clientDistribution || process.env.BCAI_DISTRIBUTION || '').trim();
  let currentSessionId = String(config.sessionId || '').trim();
  const log = config.log || console.log;

  const parsedEndpoint = new URL(cloudEndpoint);
  let cachedLease = null;
  const startedAt = new Date().toISOString();
  let totalRequests = 0;
  let totalErrors = 0;
  let totalLeases = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastRequestAt = null;
  let lastError = null;
  const quotaSnapshotMinIntervalMs = Number(config.quotaSnapshotMinIntervalMs || 15 * 60 * 1000);
  const quotaSnapshotErrorIntervalMs = Number(config.quotaSnapshotErrorIntervalMs || 2 * 60 * 1000);
  const quotaSnapshotMaxIntervalMs = Number(config.quotaSnapshotMaxIntervalMs || 30 * 60 * 1000);
  const quotaSnapshotState = new Map();
  let lastQuotaSnapshotAt = null;
  let lastQuotaSnapshotError = null;

  function saveSessionId(sessionId) {
    const cleanSessionId = String(sessionId || '').trim();
    if (!cleanSessionId || cleanSessionId === currentSessionId) return;
    currentSessionId = cleanSessionId;
    if (!configPath) return;
    try {
      const runtimeConfig = readJsonFile(configPath);
      const relay = runtimeConfig.relayProxy || {};
      runtimeConfig.relayProxy = relay;
      relay.sessionId = cleanSessionId;
      if (!relay.clientId) relay.clientId = clientId;
      writeJsonFile(configPath, runtimeConfig);
    } catch (error) {
      log(`[passthrough] failed to persist sessionId: ${error.message}`);
    }
  }

  function recordTokenUsage(capture, headers) {
    const rawBody = capture?.read?.();
    if (!rawBody) return;
    const decodedText = decodeErrorBody(rawBody, headers?.['content-encoding'], -1);
    const usage = extractTokenUsageFromText(decodedText);
    if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return;
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
  }
  let quotaSnapshotReports = 0;

  function quotaSnapshotKey(lease) {
    return String(lease?.accountId || lease?.projectId || lease?.leaseId || '');
  }

  function fetchQuotaSnapshot(lease) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ project: lease.projectId }), 'utf8');
      const endpoint = new URL(cloudEndpoint);
      const isHttps = endpoint.protocol === 'https:';
      const transport = isHttps ? https : http;
      const req = transport.request({
        method: 'POST',
        hostname: endpoint.hostname,
        port: endpoint.port || (isHttps ? 443 : 80),
        path: '/v1internal:fetchAvailableModels',
        headers: {
          authorization: `Bearer ${lease.accessToken}`,
          'content-type': 'application/json',
          'content-length': String(body.length),
          host: endpoint.host,
          'user-agent': 'google-antigravity-ls/1.26.0',
          'x-goog-api-client': 'gl-go/1.23.0 google-antigravity-ls/1.26.0',
        },
      }, (quotaRes) => {
        const chunks = [];
        quotaRes.on('data', (chunk) => chunks.push(chunk));
        quotaRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if ((quotaRes.statusCode || 500) < 200 || (quotaRes.statusCode || 500) >= 300) {
            reject(new Error(`quota HTTP ${quotaRes.statusCode}: ${raw.slice(0, 180)}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Quota snapshot timeout')));
      req.write(body);
      req.end();
    });
  }

  function scheduleQuotaSnapshot(lease, reason, options = {}) {
    if (!lease || !lease.leaseId || !lease.accessToken || !lease.projectId || !tokenServerUrl) return;
    const key = quotaSnapshotKey(lease);
    if (!key) return;
    const now = Date.now();
    const current = quotaSnapshotState.get(key) || {};
    const interval = options.error ? quotaSnapshotErrorIntervalMs : quotaSnapshotMinIntervalMs;
    if (!options.force && current.lastAt && now - current.lastAt < interval) return;
    if (!options.force && current.timer) return;

    const delay = options.immediate ? 0 : Math.floor(10000 + Math.random() * 10000);
    current.timer = setTimeout(async () => {
      const state = quotaSnapshotState.get(key) || {};
      state.timer = null;
      quotaSnapshotState.set(key, state);
      try {
        const modelsPayload = await fetchQuotaSnapshot(lease);
        const quotaGroups = summarizeQuotaModels(modelsPayload);
        const quotaRefreshedAt = new Date().toISOString();
        await postJson(joinUrl(tokenServerUrl, '/report-quota-snapshot'), {
          leaseId: lease.leaseId,
          clientId,
          accountId: lease.accountId,
          projectId: lease.projectId,
          reason,
          quotaRefreshedAt,
          quotaGroups,
          modelsJson: JSON.stringify(modelsPayload),
        }, tokenServerSecret, 10000);
        state.lastAt = Date.now();
        lastQuotaSnapshotAt = quotaRefreshedAt;
        quotaSnapshotReports++;
      } catch (error) {
        state.lastErrorAt = Date.now();
        lastQuotaSnapshotError = error.message;
        log(`[passthrough] quota snapshot failed: ${error.message}`);
      } finally {
        quotaSnapshotState.set(key, state);
      }
    }, delay);
    if (typeof current.timer.unref === 'function') current.timer.unref();
    quotaSnapshotState.set(key, current);
  }

  async function getLease(modelKey, force = false) {
    if (!force && !shouldRefreshLease(cachedLease)) {
      log(`[passthrough] lease cache hit account=#${cachedLease.accountId || '?'} project=${cachedLease.projectId || '(none)'}`);
      return cachedLease;
    }
    if (!tokenServerUrl) throw new Error('relayProxy.tokenServerUrl is not configured');

    const leaseUrl = joinUrl(tokenServerUrl, '/lease-token');
    log(
      `[passthrough] lease request url=${safeRemoteUrl(leaseUrl)} model=${modelKey || '(empty)'} ` +
      `clientId=${clientId || '(empty)'} force=${force ? 'yes' : 'no'} key=${fingerprintSecret(tokenServerSecret)}`
    );
    let lease;
    try {
      lease = await postJson(leaseUrl, {
        modelKey,
        clientId,
        clientVersion,
        clientDistribution,
        sessionId: currentSessionId,
      }, tokenServerSecret);
    } catch (error) {
      log(
        `[passthrough] lease failed status=${error.statusCode || 'n/a'} ` +
        `error=${error.message} body=${String(error.responseBody || '').slice(0, 300)}`
      );
      throw error;
    }
    lease._leasedAt = Date.now();
    saveSessionId(lease.accessKeySessionId || lease.sessionId);
    cachedLease = lease;
    totalLeases++;
    log(`[passthrough] leased #${lease.accountId || '?'} ${lease.emailHint || ''} project=${lease.projectId || '(none)'}`);
    scheduleQuotaSnapshot(cachedLease, 'lease');
    return cachedLease;
  }

  function reportResult(lease, status, modelKey) {
    if (!lease || !lease.leaseId || !tokenServerUrl) return;
    log(`[passthrough] report lease=${lease.leaseId} status=${status || 'n/a'} model=${modelKey || '(empty)'}`);
    postJson(joinUrl(tokenServerUrl, '/report-result'), {
      leaseId: lease.leaseId,
      clientId,
      status,
      modelKey,
    }, tokenServerSecret, 10000).catch((error) => {
      log(`[passthrough] report failed: ${error.message}`);
    });
    if (status === 429 || status === 503) {
      scheduleQuotaSnapshot(lease, `status_${status}`, { error: true });
    } else {
      const state = quotaSnapshotState.get(quotaSnapshotKey(lease));
      if (!state?.lastAt || Date.now() - state.lastAt > quotaSnapshotMaxIntervalMs) {
        scheduleQuotaSnapshot(lease, 'periodic');
      }
    }
  }

  function forwardOnce(req, res, rawBody, lease, modelKey) {
    return new Promise((resolve, reject) => {
      const target = new URL(req.url, cloudEndpoint);
      const prepared = prepareForwardRequest(
        req.headers,
        rawBody,
        { token: lease.accessToken, projectId: lease.projectId },
        parsedEndpoint,
        log,
        `P${totalRequests + 1}`
      );

      const isHttps = target.protocol === 'https:';
      const transport = isHttps ? https : http;
      const upstreamReq = transport.request({
        method: req.method,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: prepared.headers,
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode || 500;
        reportResult(lease, status, modelKey);

        if (status === 401 || status === 403 || status === 429 || status === 503) {
          const chunks = [];
          upstreamRes.on('data', (chunk) => chunks.push(chunk));
          upstreamRes.on('end', () => {
            resolve({
              retryable: true,
              status,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
            });
          });
          return;
        }

        const tokenUsageCapture = createTokenUsageCapture();
        upstreamRes.on('data', (chunk) => tokenUsageCapture.push(chunk));
        res.writeHead(status, sanitizeProxyResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          recordTokenUsage(tokenUsageCapture, upstreamRes.headers);
          resolve({ retryable: false, status });
        });
        upstreamRes.on('error', reject);
      });

      upstreamReq.on('error', reject);
      upstreamReq.setTimeout(300000, () => upstreamReq.destroy(new Error('Upstream request timeout')));
      if (prepared.body && prepared.body.length > 0) upstreamReq.write(prepared.body);
      upstreamReq.end();
    });
  }

  function forwardTransparent(req, res, rawBody, reqId) {
    return new Promise((resolve, reject) => {
      const target = new URL(req.url, cloudEndpoint);
      const prepared = prepareForwardRequest(
        req.headers,
        rawBody,
        { token: '', projectId: '' },
        parsedEndpoint,
        log,
        reqId
      );

      const isHttps = target.protocol === 'https:';
      const transport = isHttps ? https : http;
      const upstreamReq = transport.request({
        method: req.method,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: prepared.headers,
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode || 500;
        log(`[${reqId}] [PASS] ${target.pathname} -> ${status}`);
        res.writeHead(status, sanitizeProxyResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => resolve({ status }));
        upstreamRes.on('error', reject);
      });

      upstreamReq.on('error', reject);
      upstreamReq.setTimeout(300000, () => upstreamReq.destroy(new Error('Upstream request timeout')));
      if (prepared.body && prepared.body.length > 0) upstreamReq.write(prepared.body);
      upstreamReq.end();
    });
  }

  let requestIdCounter = 0;

  const proxyServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-goog-api-key',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'token-passthrough' }));
      return;
    }

    const pathname = new URL(req.url, `http://127.0.0.1:${proxyPort}`).pathname;
    const reqId = `P${++requestIdCounter}`;

    const isStream = pathname.includes(':streamGenerateContent');
    const isGenerate = pathname.includes(':generateContent') || isStream;

    // Non-generation calls are transparent: keep the IDE's own auth/session
    // so account setup and login behave exactly like native Antigravity.
    totalRequests++;
    lastRequestAt = new Date().toISOString();
    log(`[${reqId}] ← ${req.method} ${pathname} (${isGenerate ? (isStream ? 'stream' : 'sync') : 'pass'})`);

    try {
      const rawBody = await readBody(req);
      if (!isGenerate) {
        await forwardTransparent(req, res, rawBody, reqId);
        return;
      }

      const modelKey = extractModelKeyFromBody(req.headers, rawBody) || '';
      log(`[${reqId}] model=${modelKey || '(auto)'}`);
      let lease = await getLease(modelKey);
      let result = await forwardOnce(req, res, rawBody, lease, modelKey);

      if (result.retryable && !res.headersSent) {
        log(`[${reqId}] upstream ${result.status}; refreshing lease and retrying once`);
        cachedLease = null;
        lease = await getLease(modelKey, true);
        result = await forwardOnce(req, res, rawBody, lease, modelKey);
      }

      if (result.retryable && !res.headersSent) {
        totalErrors++;
        lastError = `Upstream ${result.status}`;
        log(`[${reqId}] ✗ final upstream ${result.status}`);
        res.writeHead(result.status, sanitizeProxyResponseHeaders(result.headers));
        res.end(result.body);
      } else {
        log(`[${reqId}] ✓ done (${result.status})`);
      }
    } catch (error) {
      totalErrors++;
      lastError = error.message;
      log(`[${reqId}] ✗ error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { code: 502, message: error.message, status: 'UNAVAILABLE' },
        }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      running: true,
      mode: 'token-passthrough',
      upstream: cloudEndpoint,
      tokenServerUrl,
      clientId,
      hasApiKey: Boolean(tokenServerSecret),
      hasLease: Boolean(cachedLease),
      activeAccountId: cachedLease?.accountId || null,
      activeEmailHint: cachedLease?.emailHint || '',
      activeProjectId: cachedLease?.projectId || '',
      startedAt,
      totalRequests,
      totalErrors,
      totalLeases,
      totalInputTokens,
      totalOutputTokens,
      lastRequestAt,
      lastError,
      quotaSnapshotMinIntervalMs,
      quotaSnapshotErrorIntervalMs,
      quotaSnapshotMaxIntervalMs,
      lastQuotaSnapshotAt,
      lastQuotaSnapshotError,
      quotaSnapshotReports,
    }, null, 2));
  });

  function shutdown() {
    log('[passthrough] shutting down');
    proxyServer.close();
    statusServer.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    start() {
      proxyServer.listen(proxyPort, '127.0.0.1', () => {
        log(`[passthrough] proxy listening on http://127.0.0.1:${proxyPort}`);
      });
      statusServer.listen(statusPort, '127.0.0.1', () => {
        log(`[passthrough] status listening on http://127.0.0.1:${statusPort}`);
      });
      return { proxyServer, statusServer };
    },
  };
}

module.exports = { createTokenPassthroughServer };
