'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const {
    createTokenManager,
    normalizeProjectId,
} = require('./token-manager');
const { createQuotaTracker } = require('./quota-tracker');
const { createQuotaPoller } = require('./quota-poller');

const DEFAULT_CLOUD_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const MAX_CAPACITY_RECOVERY_WAIT_MS = 60 * 1000;
const DEFAULT_CAPACITY_RETRY_DELAY_MS = 5000;

function formatProjectValue(currentValue, projectId) {
    const cleanProjectId = normalizeProjectId(projectId);
    if (!cleanProjectId) {
        return currentValue;
    }
    const existingValue = typeof currentValue === 'string' ? currentValue.trim() : '';
    if (!existingValue) {
        return cleanProjectId;
    }
    if (/^projects\//i.test(existingValue)) {
        return `projects/${cleanProjectId}`;
    }
    return cleanProjectId;
}

function rewriteProjectFields(value, projectId) {
    if (!value || typeof value !== 'object') {
        return { found: 0, updated: 0 };
    }

    let found = 0;
    let updated = 0;

    if (Array.isArray(value)) {
        for (const item of value) {
            const child = rewriteProjectFields(item, projectId);
            found += child.found;
            updated += child.updated;
        }
        return { found, updated };
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'project') {
            found += 1;
            const nextValue = formatProjectValue(childValue, projectId);
            if (nextValue !== childValue) {
                value[key] = nextValue;
                updated += 1;
            }
            continue;
        }

        if (childValue && typeof childValue === 'object') {
            const child = rewriteProjectFields(childValue, projectId);
            found += child.found;
            updated += child.updated;
        }
    }

    return { found, updated };
}

function rewriteProjectFieldsInBody(headers, rawBody, projectId, log, reqId) {
    const contentType = String(headers['content-type'] || '').toLowerCase();
    if (!rawBody.length || !contentType.includes('application/json')) {
        return {
            body: rawBody,
            projectFound: false,
            projectUpdated: false,
        };
    }

    let parsed;
    try {
        parsed = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
        log(`[token-proxy] #${reqId} JSON parse skipped: ${error.message}`);
        return {
            body: rawBody,
            projectFound: false,
            projectUpdated: false,
        };
    }

    const rewrite = rewriteProjectFields(parsed, projectId);
    if (rewrite.updated === 0) {
        return {
            body: rawBody,
            projectFound: rewrite.found > 0,
            projectUpdated: false,
        };
    }

    return {
        body: Buffer.from(JSON.stringify(parsed)),
        projectFound: true,
        projectUpdated: true,
    };
}

function prepareForwardRequest(reqHeaders, rawBody, tokenInfo, parsedEndpoint, log, reqId) {
    const rewritten = rewriteProjectFieldsInBody(
        reqHeaders,
        rawBody,
        tokenInfo.projectId,
        log,
        reqId
    );

    const fwdHeaders = { ...reqHeaders };
    delete fwdHeaders.host;
    delete fwdHeaders.connection;
    delete fwdHeaders['transfer-encoding'];

    let authMode = 'passthrough';
    if (tokenInfo.projectId && rewritten.projectFound) {
        delete fwdHeaders.authorization;
        fwdHeaders.authorization = `Bearer ${tokenInfo.token}`;
        authMode = 'account';
    } else if (!fwdHeaders.authorization) {
        fwdHeaders.authorization = `Bearer ${tokenInfo.token}`;
        authMode = 'fallback';
    }

    // (pass-through auth — no log needed)

    fwdHeaders.host = parsedEndpoint.host;
    if (rewritten.body.length > 0) {
        fwdHeaders['content-length'] = rewritten.body.length;
    } else {
        delete fwdHeaders['content-length'];
    }

    return {
        headers: fwdHeaders,
        body: rewritten.body,
        authMode,
        projectFound: rewritten.projectFound,
        projectUpdated: rewritten.projectUpdated,
    };
}

function decodeErrorBody(rawBody, contentEncoding, maxLength = 2000) {
    try {
        const encoding = String(contentEncoding || '').toLowerCase();
        let text = '';
        if (encoding.includes('gzip')) {
            text = zlib.gunzipSync(rawBody).toString('utf8');
        } else {
            text = rawBody.toString('utf8');
        }

        const limit = Number(maxLength);
        if (Number.isFinite(limit) && limit >= 0) {
            return text.substring(0, limit);
        }
        return text;
    } catch {
        const text = rawBody.toString('utf8');
        const limit = Number(maxLength);
        if (Number.isFinite(limit) && limit >= 0) {
            return text ? text.substring(0, limit) : `(binary ${rawBody.length} bytes)`;
        }
        return text || `(binary ${rawBody.length} bytes)`;
    }
}

function findFirstStringByKey(value, targetKey) {
    if (!value || typeof value !== 'object') {
        return '';
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const match = findFirstStringByKey(item, targetKey);
            if (match) {
                return match;
            }
        }
        return '';
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key === targetKey && typeof childValue === 'string' && childValue.trim()) {
            return childValue.trim();
        }
        if (childValue && typeof childValue === 'object') {
            const match = findFirstStringByKey(childValue, targetKey);
            if (match) {
                return match;
            }
        }
    }

    return '';
}

function extractModelKeyFromBody(headers, rawBody) {
    const contentType = String(headers['content-type'] || '').toLowerCase();
    if (!rawBody.length || !contentType.includes('application/json')) {
        return '';
    }

    try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        return findFirstStringByKey(parsed, 'model');
    } catch {
        return '';
    }
}

function isLowSignalModel(modelKey) {
    return /^tab_/i.test(String(modelKey || '').trim());
}

function shouldLogPrimaryConversation(reqUrl, modelKey) {
    const url = String(reqUrl || '');
    if (!url.includes('streamGenerateContent')) {
        return false;
    }

    const cleanModelKey = String(modelKey || '').trim();
    if (!cleanModelKey) {
        return true;
    }

    return !isLowSignalModel(cleanModelKey);
}

function extractCapacityModelKey(errorText) {
    const rawText = String(errorText || '').trim();
    if (!rawText) {
        return '';
    }

    try {
        const parsed = JSON.parse(rawText);
        const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
        const matched = details.find((item) => String(item?.metadata?.model || '').trim());
        if (matched?.metadata?.model) {
            return String(matched.metadata.model).trim();
        }
    } catch {
        // Fall back to plain-text parsing.
    }

    const match = rawText.match(/No capacity available for model ([A-Za-z0-9._-]+)/i);
    return match ? String(match[1] || '').trim() : '';
}

function parseDurationToMs(value) {
    const text = String(value || '').trim();
    if (!text) {
        return 0;
    }

    let totalMs = 0;
    const pattern = /(\d+(?:\.\d+)?)(h|m|s)/gi;
    let matched = false;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        matched = true;
        const amount = Number(match[1]);
        const unit = String(match[2] || '').toLowerCase();
        if (!Number.isFinite(amount)) {
            continue;
        }
        if (unit === 'h') {
            totalMs += amount * 60 * 60 * 1000;
        } else if (unit === 'm') {
            totalMs += amount * 60 * 1000;
        } else if (unit === 's') {
            totalMs += amount * 1000;
        }
    }

    return matched ? Math.ceil(totalMs) : 0;
}

function parseQuotaResetTimestampToMs(value, nowMs = Date.now()) {
    const text = String(value || '').trim();
    if (!text) {
        return 0;
    }

    const resetAtMs = Date.parse(text);
    if (!Number.isFinite(resetAtMs)) {
        return 0;
    }
    return Math.max(0, resetAtMs - nowMs);
}

function extractQuotaResetDelayMs(errorText, nowMs = Date.now()) {
    const rawText = String(errorText || '').trim();
    if (!rawText) {
        return 0;
    }

    let sawResetHint = false;

    try {
        const parsed = JSON.parse(rawText);
        const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
        for (const item of details) {
            const metadata = item?.metadata || {};
            if (String(metadata.quotaResetDelay || '').trim()) {
                sawResetHint = true;
                const delayMs = parseDurationToMs(metadata.quotaResetDelay);
                if (delayMs > 0) {
                    return delayMs;
                }
            }
            if (String(metadata.quotaResetTimeStamp || '').trim()) {
                sawResetHint = true;
                const delayMs = parseQuotaResetTimestampToMs(metadata.quotaResetTimeStamp, nowMs);
                if (delayMs > 0) {
                    return delayMs;
                }
            }
        }

        if (/reset after/i.test(String(parsed?.error?.message || ''))) {
            sawResetHint = true;
        }
        const messageDelay = parseDurationToMs(parsed?.error?.message);
        if (messageDelay > 0) {
            return messageDelay;
        }
    } catch {
        // Fall back to plain-text parsing.
    }

    const messageMatch = rawText.match(/reset after ([^.:]+(?:\.\d+)?s)/i);
    if (messageMatch) {
        sawResetHint = true;
        const delayMs = parseDurationToMs(messageMatch[1]);
        if (delayMs > 0) {
            return delayMs;
        }
    }

    const refreshOnMatch = rawText.match(/(?:refresh|reset)\s+on\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4},?\s+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i);
    if (refreshOnMatch) {
        sawResetHint = true;
        const delayMs = parseQuotaResetTimestampToMs(refreshOnMatch[1], nowMs);
        if (delayMs > 0) {
            return delayMs;
        }
    }

    const delayMs = parseDurationToMs(rawText);
    if (delayMs > 0) {
        return delayMs;
    }

    return sawResetHint ? 1 : 0;
}

function getRotationDetails(statusCode, authMode, errorText, fallbackModelKey = '') {
    if (authMode !== 'account') {
        return { reason: '', modelKey: '', retryAfterMs: 0 };
    }

    if (statusCode !== 503) {
        if (statusCode === 429) {
            return {
                reason: 'quota',
                modelKey: extractCapacityModelKey(errorText) || String(fallbackModelKey || '').trim(),
                retryAfterMs: extractQuotaResetDelayMs(errorText),
            };
        }
        return { reason: '', modelKey: '', retryAfterMs: 0 };
    }

    const text = String(errorText || '').toLowerCase();
    const capacityModelKey = extractCapacityModelKey(errorText) || String(fallbackModelKey || '').trim();
    if (
        text.includes('no capacity available') ||
        text.includes('capacity available for model') ||
        Boolean(capacityModelKey)
    ) {
        return {
            reason: 'capacity',
            modelKey: capacityModelKey,
            retryAfterMs: extractQuotaResetDelayMs(errorText),
        };
    }

    return { reason: '', modelKey: '', retryAfterMs: 0 };
}

function getErrorSnippet(value) {
    const text = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, 1200);
}

function getRotationReason(statusCode, authMode, errorText, fallbackModelKey = '') {
    return getRotationDetails(statusCode, authMode, errorText, fallbackModelKey).reason;
}

function getStreamingRotationDetails(text, fallbackModelKey = '') {
    const raw = String(text || '');
    if (!raw) return { reason: '', modelKey: '', retryAfterMs: 0 };
    const lower = raw.toLowerCase();
    const modelKey = extractCapacityModelKey(raw) || String(fallbackModelKey || '').trim();
    if (
        lower.includes('baseline model quota reached') ||
        lower.includes('quota reached') ||
        lower.includes('quota_exhausted') ||
        lower.includes('resource_exhausted')
    ) {
        return {
            reason: 'quota',
            modelKey,
            retryAfterMs: extractQuotaResetDelayMs(raw),
        };
    }
    if (
        lower.includes('model_capacity_exhausted') ||
        lower.includes('no capacity available') ||
        lower.includes('capacity available for model')
    ) {
        return {
            reason: 'capacity',
            modelKey,
            retryAfterMs: extractQuotaResetDelayMs(raw),
        };
    }
    return { reason: '', modelKey: '', retryAfterMs: 0 };
}

function sanitizeProxyResponseHeaders(headers, options = {}) {
    const next = { ...(headers || {}) };
    delete next.connection;

    if (options.isStreaming) {
        delete next['content-length'];
        return next;
    }

    // Recompute the body length we actually send back so Antigravity
    // doesn't see a truncated error payload and fail with unexpected EOF.
    delete next['transfer-encoding'];
    if (options.bodyLength !== undefined) {
        next['content-length'] = String(Math.max(0, Number(options.bodyLength) || 0));
    }
    return next;
}

function shouldRetryWithAnotherAccount(rotated, attempts, maxRetries, attemptedCount, rotatableCount) {
    return Boolean(rotated) &&
        attempts <= maxRetries &&
        attemptedCount < rotatableCount;
}

function shouldWaitForCapacityRecovery(unavailable, attempts, maxRetries, accumulatedWaitMs) {
    const reason = String(unavailable?.reason || '').trim();
    if (reason !== 'capacity') {
        return false;
    }
    // Use default delay if server didn't provide retryAfterMs
    const retryAfterMs = Number(unavailable?.nextRetryAfterMs || 0) || DEFAULT_CAPACITY_RETRY_DELAY_MS;
    if (retryAfterMs > MAX_CAPACITY_RECOVERY_WAIT_MS) {
        return false;
    }
    // Allow more attempts for capacity errors (server-side congestion is transient)
    const capacityMaxRetries = Math.max(maxRetries, 5);
    if (attempts > capacityMaxRetries) {
        return false;
    }
    return Number(accumulatedWaitMs || 0) + retryAfterMs <= MAX_CAPACITY_RECOVERY_WAIT_MS;
}

function readJsonFile(filePath, fallback = {}) {
    if (!filePath) return fallback;
    try {
        const raw = require('fs').readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        return raw.trim() ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
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

function joinUrl(base, urlPath) {
    return `${String(base || '').replace(/\/+$/, '')}/${String(urlPath || '').replace(/^\/+/, '')}`;
}

function shouldRefreshLease(lease) {
    if (!lease || !lease.accessToken || !lease.projectId) return true;
    const expiresAt = Date.parse(lease.expiresAt || '');
    if (Number.isFinite(expiresAt)) {
        return expiresAt < Date.now() + 60 * 1000;
    }
    const leasedAt = Number(lease._leasedAt) || 0;
    return leasedAt > 0 ? Date.now() > leasedAt + 45 * 60 * 1000 : true;
}

function formatRetryDelayText(retryAfterMs) {
    const totalSeconds = Math.max(0, Math.ceil(Number(retryAfterMs || 0) / 1000));
    if (totalSeconds <= 0) {
        return '0s';
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }
    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds}s`);
    }
    return parts.join('');
}

function buildUnavailableAccountsResponse(unavailable, fallbackModelKey = '') {
    const modelKey = String(unavailable?.modelKey || fallbackModelKey || '').trim();
    const retryAfterMs = Number(unavailable?.nextRetryAfterMs || 0);
    const retryDelayText = formatRetryDelayText(retryAfterMs);
    const reason = String(unavailable?.reason || '').trim();

    if (reason === 'quota') {
        return {
            statusCode: 429,
            payload: {
                error: {
                    code: 429,
                    message: retryAfterMs > 0
                        ? `You have exhausted your capacity on this model. Your quota will reset after ${retryDelayText}.`
                        : 'You have exhausted your capacity on this model.',
                    status: 'RESOURCE_EXHAUSTED',
                    details: [
                        {
                            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                            reason: 'QUOTA_EXHAUSTED',
                            domain: 'cloudcode-pa.googleapis.com',
                            metadata: {
                                uiMessage: 'true',
                                model: modelKey,
                                quotaResetDelay: retryDelayText,
                            },
                        },
                    ],
                },
            },
        };
    }

    return {
        statusCode: 503,
        payload: {
            error: {
                code: 503,
                message: modelKey
                    ? `No capacity available for model ${modelKey} on the server`
                    : 'No available accounts',
                status: 'UNAVAILABLE',
                details: [
                    {
                        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                        reason: 'MODEL_CAPACITY_EXHAUSTED',
                        domain: 'cloudcode-pa.googleapis.com',
                        metadata: {
                            model: modelKey,
                        },
                    },
                    {
                        '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                        retryDelay: retryDelayText,
                    },
                ],
            },
        },
    };
}

/**
 * Cloud Code Endpoint reverse proxy.
 * Sits between the Antigravity LS and Google Cloud,
 * injects per-account OAuth Bearer tokens and handles 429 rotation.
 */
function createTokenProxy(config) {
    const {
        proxyPort,
        accountsFilePath,
        cloudEndpoint = DEFAULT_CLOUD_ENDPOINT,
        cooldownMs = 60000,
        maxRetries = 3,
        log = console.log,
        oauthClientId,
        runtimeStatePath,
        configPath,
    } = config;

    const parsedEndpoint = new URL(cloudEndpoint);

    const tokenManager = createTokenManager({
        accountsFilePath,
        log,
        oauthClientId,
        cloudEndpoint,
        runtimeStatePath,
    });
    const quotaTracker = createQuotaTracker({ tokenManager, log, cooldownMs });
    const quotaPoller = createQuotaPoller({ tokenManager, cloudEndpoint, log, pollIntervalMs: 5 * 60 * 1000 });

    let server = null;
    let requestCount = 0;
    let rotationCount = 0;
    let cachedRemoteLease = null;
    let remoteLeaseCount = 0;
    let remoteReportCount = 0;
    let remoteErrorCount = 0;
    let lastRemoteError = null;
    let lastAccessKeyStatus = null;

    function getRuntimeTokenMode() {
        const runtimeConfig = readJsonFile(configPath, {});
        const mode = String(
            runtimeConfig.tokenProxyMode ||
            runtimeConfig.tokenSource ||
            runtimeConfig.relayProxy?.tokenSource ||
            'local'
        ).trim().toLowerCase();
        const relay = runtimeConfig.relayProxy || {};
        return {
            mode: mode === 'remote' || mode === 'token-passthrough' || mode === 'relay'
                ? 'remote'
                : 'local',
            tokenServerUrl: String(relay.tokenServerUrl || runtimeConfig.remoteTokenServerUrl || '').trim(),
            tokenServerSecret: String(relay.tokenServerSecret || relay.apiKey || runtimeConfig.remoteTokenServerSecret || '').trim(),
        };
    }

    async function getRemoteToken(modelKey, force = false) {
        const runtime = getRuntimeTokenMode();
        if (!runtime.tokenServerUrl) {
            throw new Error('Remote token mode is enabled but relayProxy.tokenServerUrl is not configured.');
        }
        if (!force && !shouldRefreshLease(cachedRemoteLease)) {
            log(`[token-proxy] remote lease cache hit account=#${cachedRemoteLease.accountId || '?'} project=${cachedRemoteLease.projectId || '(none)'}`);
            return cachedRemoteLease;
        }
        const leaseUrl = joinUrl(runtime.tokenServerUrl, '/lease-token');
        log(
            `[token-proxy] remote lease request url=${safeRemoteUrl(leaseUrl)} ` +
            `model=${modelKey || '(empty)'} force=${force ? 'yes' : 'no'} ` +
            `key=${fingerprintSecret(runtime.tokenServerSecret)}`
        );
        let lease;
        try {
            lease = await postJson(
                leaseUrl,
                { modelKey, reason: 'token-proxy-remote-mode' },
                runtime.tokenServerSecret
            );
        } catch (error) {
            remoteErrorCount++;
            lastRemoteError = error.message;
            log(
                `[token-proxy] remote lease failed status=${error.statusCode || 'n/a'} ` +
                `error=${error.message} body=${String(error.responseBody || '').slice(0, 300)}`
            );
            throw error;
        }
        lease._leasedAt = Date.now();
        lastAccessKeyStatus = lease.accessKeyStatus || lastAccessKeyStatus;
        cachedRemoteLease = {
            token: lease.accessToken,
            accountId: lease.accountId || 0,
            email: lease.emailHint || 'remote-token',
            projectId: lease.projectId || '',
            canRotate: true,
            reservation: null,
            remoteLease: true,
            leaseId: lease.leaseId || '',
        };
        remoteLeaseCount++;
        lastRemoteError = null;
        log(`[token-proxy] remote lease #${cachedRemoteLease.accountId || '?'} ${cachedRemoteLease.email} project=${cachedRemoteLease.projectId || '(none)'}`);
        return cachedRemoteLease;
    }

    function reportRemoteResult(tokenInfo, status, modelKey, details = {}) {
        if (!tokenInfo?.remoteLease || !tokenInfo.leaseId) return;
        const runtime = getRuntimeTokenMode();
        if (!runtime.tokenServerUrl) return;
        remoteReportCount++;
        log(`[token-proxy] remote report lease=${tokenInfo.leaseId} status=${status || 'n/a'} model=${modelKey || '(empty)'}`);
        return postJson(joinUrl(runtime.tokenServerUrl, '/report-result'), {
            leaseId: tokenInfo.leaseId,
            status,
            modelKey,
            reason: details.reason,
            retryAfterMs: details.retryAfterMs,
            errorText: getErrorSnippet(details.errorText || details.errText || details.message),
        }, runtime.tokenServerSecret, 10000).catch((error) => {
            remoteErrorCount++;
            lastRemoteError = error.message;
            log(`[token-proxy] remote report failed: ${error.message}`);
        });
    }

    function forwardRequest(method, reqPath, headers, body) {
        return new Promise((resolve, reject) => {
            const targetUrl = new URL(reqPath, cloudEndpoint);
            const options = {
                hostname: parsedEndpoint.hostname,
                port: parsedEndpoint.port || (parsedEndpoint.protocol === 'https:' ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method,
                headers,
            };

            const transport = parsedEndpoint.protocol === 'https:' ? https : http;
            const proxyReq = transport.request(options, resolve);
            proxyReq.on('error', reject);
            if (body && body.length > 0) proxyReq.write(body);
            proxyReq.end();
        });
    }

    async function handleRequest(req, res) {
        requestCount++;
        const reqId = requestCount;
        const ct = req.headers['content-type'] || '';
        const requestStartedAt = Date.now();

        const bodyChunks = [];
        for await (const chunk of req) bodyChunks.push(chunk);
        const reqBody = Buffer.concat(bodyChunks);
        const requestModelKey = extractModelKeyFromBody(req.headers, reqBody);
        const isGenerationRequest = req.url.includes('streamGenerateContent');
        const shouldLogConversation = shouldLogPrimaryConversation(req.url, requestModelKey);

        // Request entry log removed — response line is sufficient


        let attempts = 0;
        let lastError = null;
        const attemptedAccountIds = new Set();
        let accumulatedWaitMs = 0;
        const requestUsesRemoteToken = getRuntimeTokenMode().mode === 'remote';

        // Allow enough attempts to try ALL rotatable accounts for quota/capacity rotation,
        // not just maxRetries (which is meant for network errors).
        const rotatableCount = requestUsesRemoteToken ? Math.max(1, maxRetries + 1) : quotaTracker.getStatus().rotatableAccounts;
        const maxAttempts = Math.max(maxRetries, rotatableCount);

        while (attempts <= maxAttempts) {
            attempts++;
            let tokenInfo;
            try {
                if (requestUsesRemoteToken) {
                    tokenInfo = await getRemoteToken(requestModelKey, attempts > 1);
                } else {
                    tokenInfo = await quotaTracker.getActiveToken({
                        modelKey: requestModelKey,
                        balanceLoad: isGenerationRequest,
                        trackInFlight: isGenerationRequest,
                        requireProjectId: isGenerationRequest,
                    });
                }
                attemptedAccountIds.add(tokenInfo.accountId);
            } catch (error) {
                const unavailable = quotaTracker.getModelAvailability({
                    modelKey: requestModelKey,
                    requireProjectId: isGenerationRequest,
                });
                // Synthesize retry delay for capacity errors without explicit retryAfterMs
                if (unavailable?.reason === 'capacity' && !unavailable?.nextRetryAfterMs) {
                    unavailable.nextRetryAfterMs = DEFAULT_CAPACITY_RETRY_DELAY_MS;
                }
                const shouldWaitForRetry = shouldWaitForCapacityRecovery(
                    unavailable,
                    attempts,
                    maxRetries,
                    accumulatedWaitMs
                );

                if (shouldWaitForRetry) {
                    const waitMs = Number(unavailable.nextRetryAfterMs || DEFAULT_CAPACITY_RETRY_DELAY_MS);
                    accumulatedWaitMs += waitMs;
                    log(
                        `[token-proxy] #${reqId} Waiting ${Math.ceil(waitMs / 1000)}s ` +
                        `for ${requestModelKey || 'account availability'}`
                    );
                    await new Promise((resolve) => setTimeout(resolve, waitMs + 150));
                    continue;
                }

                log(`[token-proxy] #${reqId} No token: ${error.message}`);
                if (unavailable?.reason) {
                    const response = buildUnavailableAccountsResponse(unavailable, requestModelKey);
                    res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(response.payload));
                    return;
                }
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No available accounts' }));
                return;
            }

            let reservationReleased = false;
            const releaseReservation = () => {
                if (reservationReleased) {
                    return;
                }
                reservationReleased = true;
                quotaTracker.releaseReservation(tokenInfo.reservation);
            };

            const prepared = prepareForwardRequest(
                req.headers,
                reqBody,
                tokenInfo,
                parsedEndpoint,
                log,
                reqId
            );

            try {
                const proxyRes = await forwardRequest(
                    req.method,
                    req.url,
                    prepared.headers,
                    prepared.body
                );

                if (shouldLogConversation || proxyRes.statusCode >= 400) {
                    log(
                        `[token-proxy] #${reqId} → ${proxyRes.statusCode} ` +
                        `(${tokenInfo.email}, auth=${prepared.authMode}` +
                        (prepared.projectUpdated ? ', project=updated' : '') +
                        ')'
                    );
                }

                if (proxyRes.statusCode === 429) {
                    const errChunks = [];
                    for await (const c of proxyRes) errChunks.push(c);
                    const rawErr = Buffer.concat(errChunks);
                    const errText = decodeErrorBody(rawErr, proxyRes.headers['content-encoding']);
                    releaseReservation();
                    const rotation = getRotationDetails(
                        proxyRes.statusCode,
                        prepared.authMode,
                        errText,
                        requestModelKey
                    );
                    rotation.errorText = errText;
                    await reportRemoteResult(tokenInfo, proxyRes.statusCode, rotation.modelKey || requestModelKey, rotation);
                    if (tokenInfo.remoteLease && attempts < maxAttempts) {
                        cachedRemoteLease = null;
                        log(`[token-proxy] #${reqId} remote 429; refreshing lease and retrying...`);
                        await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
                        continue;
                    }
                    if (tokenInfo.remoteLease) {
                        log(`[token-proxy] #${reqId} remote ERROR 429: ${errText.substring(0, 500)}`);
                        const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
                            bodyLength: rawErr.length,
                        });
                        res.writeHead(proxyRes.statusCode, resHeaders);
                        res.end(rawErr);
                        return;
                    }
                    if (prepared.authMode !== 'account') {
                        log(
                            `[token-proxy] #${reqId} 429 received in ${prepared.authMode} mode; ` +
                            'cannot rotate without replacing both token and project'
                        );
                    } else {
                        // Short rate-limit (< 5s): wait and retry SAME account, don't mark exhausted
                        const isShortRateLimit = rotation.retryAfterMs > 0 && rotation.retryAfterMs < 5000
                            && String(errText).includes('RATE_LIMIT_EXCEEDED');
                        if (isShortRateLimit && attempts < maxRetries + 2) {
                            const waitMs = rotation.retryAfterMs + 500;
                            log(`[token-proxy] #${reqId} rate-limited ${rotation.retryAfterMs}ms, waiting ${waitMs}ms and retrying same account`);
                            await new Promise((r) => setTimeout(r, waitMs));
                            continue;
                        }

                        const rotated = quotaTracker.reportQuotaExhausted(tokenInfo.accountId, {
                            reason: rotation.reason || 'quota',
                            modelKey: rotation.modelKey,
                            retryAfterMs: rotation.retryAfterMs,
                        });
                        if (rotated) {
                            rotationCount++;
                        }
                        if (shouldRetryWithAnotherAccount(
                            rotated,
                            attempts,
                            maxAttempts,
                            attemptedAccountIds.size,
                            quotaTracker.getStatus().rotatableAccounts
                        )) {
                            await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
                            continue;
                        }
                    }

                    log(`[token-proxy] #${reqId} ERROR 429: ${errText.substring(0, 500)}`);
                    const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
                        bodyLength: rawErr.length,
                    });
                    res.writeHead(proxyRes.statusCode, resHeaders);
                    res.end(rawErr);
                    return;
                }

                if (proxyRes.statusCode >= 400) {
                    const errChunks = [];
                    for await (const c of proxyRes) errChunks.push(c);
                    const rawErr = Buffer.concat(errChunks);
                    const errText = decodeErrorBody(rawErr, proxyRes.headers['content-encoding']);
                    releaseReservation();
                    const rotation = getRotationDetails(
                        proxyRes.statusCode,
                        prepared.authMode,
                        errText,
                        requestModelKey
                    );
                    rotation.errorText = errText;
                    if (tokenInfo.remoteLease && (proxyRes.statusCode === 401 || proxyRes.statusCode === 403 || proxyRes.statusCode === 503) && attempts < maxAttempts) {
                        await reportRemoteResult(tokenInfo, proxyRes.statusCode, rotation.modelKey || requestModelKey, rotation);
                        cachedRemoteLease = null;
                        log(`[token-proxy] #${reqId} remote ${proxyRes.statusCode}; refreshing lease and retrying...`);
                        await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
                        continue;
                    }
                    if (tokenInfo.remoteLease) {
                        log(`[token-proxy] #${reqId} remote ERROR ${proxyRes.statusCode}: ${errText.substring(0, 500)}`);
                        const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
                            bodyLength: rawErr.length,
                        });
                        res.writeHead(proxyRes.statusCode, resHeaders);
                        res.end(rawErr);
                        return;
                    }
                    if (rotation.reason) {
                        log(
                            `[token-proxy] #${reqId} ${proxyRes.statusCode} ${rotation.reason} hit, rotating...`
                        );
                        // Capacity (503) is transient server congestion; use short cooldown, not the full 60s default
                        const effectiveRetryMs = rotation.reason === 'capacity' && !rotation.retryAfterMs
                            ? 5000
                            : rotation.retryAfterMs;
                        const rotated = quotaTracker.reportQuotaExhausted(tokenInfo.accountId, {
                            reason: rotation.reason,
                            modelKey: rotation.modelKey,
                            retryAfterMs: effectiveRetryMs,
                        });
                        if (rotated) {
                            rotationCount++;
                        }
                        if (shouldRetryWithAnotherAccount(
                            rotated,
                            attempts,
                            maxAttempts,
                            attemptedAccountIds.size,
                            quotaTracker.getStatus().rotatableAccounts
                        )) {
                            await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
                            continue;
                        }

                        // Even if no other account is available, wait and retry for capacity errors
                        const unavailable = quotaTracker.getModelAvailability({
                            modelKey: requestModelKey,
                            requireProjectId: isGenerationRequest,
                        });
                        // For capacity errors, synthesize a retry hint if server didn't provide one
                        if (rotation.reason === 'capacity' && !unavailable?.nextRetryAfterMs) {
                            unavailable.nextRetryAfterMs = DEFAULT_CAPACITY_RETRY_DELAY_MS;
                            unavailable.reason = 'capacity';
                        }
                        if (shouldWaitForCapacityRecovery(
                            unavailable,
                            attempts,
                            maxRetries,
                            accumulatedWaitMs
                        )) {
                            const waitMs = Number(unavailable.nextRetryAfterMs || DEFAULT_CAPACITY_RETRY_DELAY_MS);
                            accumulatedWaitMs += waitMs;
                            log(
                                `[token-proxy] #${reqId} Capacity retry in ` +
                                `${Math.ceil(waitMs / 1000)}s for ${requestModelKey}`
                            );
                            await new Promise((r) => setTimeout(r, waitMs + 150));
                            continue;
                        }
                    }

                    log(`[token-proxy] #${reqId} ERROR ${proxyRes.statusCode}: ${errText.substring(0, 500)}`);
                    const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
                        bodyLength: rawErr.length,
                    });
                    res.writeHead(proxyRes.statusCode, resHeaders);
                    res.end(rawErr);
                    return;
                }

                const isStreaming = req.url.includes('streamGenerate') ||
                    String(proxyRes.headers['content-type'] || '').includes('text/event-stream');

                if (tokenInfo.remoteLease && !isStreaming) {
                    reportRemoteResult(tokenInfo, proxyRes.statusCode || 200, requestModelKey);
                } else if (!isStreaming && prepared.authMode !== 'passthrough') {
                    quotaTracker.reportSuccess(tokenInfo.accountId, {
                        modelKey: requestModelKey,
                    });
                }

                const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, { isStreaming });
                let responseBytes = 0;
                let responseEnded = false;
                let clientClosed = false;
                let streamReportedFailure = false;

                const shouldInterceptBody = Math.floor(proxyRes.statusCode / 100) === 2 &&
                    (req.url.includes('fetchUserInfo') || req.url.includes('cascadeNuxes') || req.url.includes('fetchAvailableModels'));
                const bodyChunks = [];

                // Stream timeout with socket-health-aware grace periods.
                // Phase 1 (first byte): long timeout for model thinking.
                // Phase 2 (mid-stream): when timer fires, check TCP socket health:
                //   - Socket dead → connection silently dropped, force end immediately.
                //   - Socket alive → model likely still thinking, grant grace period.
                //   - Max total idle reached → force end to prevent infinite waiting.
                let streamInactivityTimer = null;
                const STREAM_FIRST_BYTE_MS = 180000; // 3 min for initial thinking
                const STREAM_MID_CHECK_MS = 60000; // 60s: first mid-stream health check
                const STREAM_GRACE_MS = 30000; // 30s per grace extension when socket alive
                const isThinkingModel = /thinking|think/i.test(requestModelKey);
                const STREAM_MAX_IDLE_MS = isLowSignalModel(requestModelKey) ? 30000
                    : isThinkingModel ? 240000 : 150000;
                let streamHasData = false;
                let lastDataAt = Date.now();

                const forceEndStream = (reason) => {
                    log(`[token-proxy] #${reqId} stream end: ${reason}`);
                    if (prepared.authMode === 'account') {
                        quotaTracker.reportStreamHang(tokenInfo.accountId);
                    }
                    proxyRes.destroy();
                    if (!res.writableEnded) res.end();
                };

                const checkStreamHealth = () => {
                    if (responseEnded || clientClosed) return;

                    const totalIdleMs = Date.now() - lastDataAt;

                    if (!streamHasData) {
                        forceEndStream(`first-byte timeout (${STREAM_FIRST_BYTE_MS / 1000}s)`);
                        return;
                    }

                    // Check TCP socket: is the upstream connection still alive?
                    const socket = proxyRes.socket;
                    const socketAlive = socket
                        && !socket.destroyed
                        && socket.readable
                        && !proxyRes.complete;

                    if (!socketAlive) {
                        forceEndStream(`socket dead after ${Math.ceil(totalIdleMs / 1000)}s idle`);
                        return;
                    }

                    if (totalIdleMs >= STREAM_MAX_IDLE_MS) {
                        forceEndStream(`max idle ${Math.ceil(totalIdleMs / 1000)}s (limit=${STREAM_MAX_IDLE_MS / 1000}s)`);
                        return;
                    }

                    // Socket alive + under max idle → model still thinking, grant grace
                    const remaining = STREAM_MAX_IDLE_MS - totalIdleMs;
                    const nextCheck = Math.min(STREAM_GRACE_MS, remaining);
                    if (shouldLogConversation) {
                        log(
                            `[token-proxy] #${reqId} stream idle ${Math.ceil(totalIdleMs / 1000)}s, ` +
                            `socket alive, grace +${Math.ceil(nextCheck / 1000)}s`
                        );
                    }
                    streamInactivityTimer = setTimeout(checkStreamHealth, nextCheck);
                };

                const resetStreamTimer = () => {
                    if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
                    lastDataAt = Date.now();
                    const timeoutMs = streamHasData ? STREAM_MID_CHECK_MS : STREAM_FIRST_BYTE_MS;
                    streamInactivityTimer = setTimeout(checkStreamHealth, timeoutMs);
                };
                if (isStreaming) resetStreamTimer();

                proxyRes.on('data', (chunk) => {
                    responseBytes += chunk.length;
                    if (isStreaming) {
                        streamHasData = true;
                        resetStreamTimer();
                        if (!streamReportedFailure) {
                            const rotation = getStreamingRotationDetails(chunk.toString('utf8'), requestModelKey);
                            if (rotation.reason) {
                                streamReportedFailure = true;
                                const status = rotation.reason === 'capacity' ? 503 : 429;
                                log(
                                    `[token-proxy] #${reqId} stream ${rotation.reason} hit` +
                                    (rotation.modelKey ? ` (${rotation.modelKey})` : '') +
                                    ', marking account for rotation'
                                );
                                if (tokenInfo.remoteLease) {
                                    reportRemoteResult(tokenInfo, status, rotation.modelKey || requestModelKey, rotation);
                                    cachedRemoteLease = null;
                                } else if (prepared.authMode === 'account') {
                                    quotaTracker.reportQuotaExhausted(tokenInfo.accountId, {
                                        reason: rotation.reason,
                                        modelKey: rotation.modelKey || requestModelKey,
                                        retryAfterMs: rotation.retryAfterMs,
                                    });
                                }
                            }
                        }
                    }
                    if (shouldInterceptBody) {
                        bodyChunks.push(chunk);
                    }
                });
                proxyRes.on('end', () => {
                    responseEnded = true;
                    if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
                    releaseReservation();
                    if (isStreaming && !streamReportedFailure) {
                        if (tokenInfo.remoteLease) {
                            reportRemoteResult(tokenInfo, proxyRes.statusCode || 200, requestModelKey);
                        } else if (prepared.authMode !== 'passthrough') {
                            quotaTracker.reportSuccess(tokenInfo.accountId, {
                                modelKey: requestModelKey,
                            });
                        }
                    }
                    // Stream end log removed — response line is sufficient
                    if (shouldInterceptBody && bodyChunks.length > 0) {
                        try {
                            const rawBody = Buffer.concat(bodyChunks);
                            const contentEncoding = proxyRes.headers['content-encoding'];
                            const decodedText = decodeErrorBody(rawBody, contentEncoding, -1);
                            if (decodedText && decodedText.includes('"models"')) {
                                tokenManager.updateProjectModels(tokenInfo.accountId, decodedText);
                            }
                        } catch (e) {
                            log(`[token-proxy] Failed to parse models json: ${e.message}`);
                        }
                    }
                });
                proxyRes.on('aborted', () => {
                    releaseReservation();
                    if (shouldLogConversation) {
                        log(
                            `[token-proxy] #${reqId} upstream aborted ` +
                            `${responseBytes}B ${Date.now() - requestStartedAt}ms`
                        );
                    }
                    // Signal end to client so it doesn't hang
                    if (!res.writableEnded) {
                        res.end();
                    }
                });
                res.on('close', () => {
                    releaseReservation();
                    if (!responseEnded && !clientClosed && shouldLogConversation) {
                        clientClosed = true;
                        log(
                            `[token-proxy] #${reqId} client closed early ` +
                            `${responseBytes}B ${Date.now() - requestStartedAt}ms`
                        );
                        // Destroy upstream to prevent resource leak
                        proxyRes.destroy();
                    }
                });
                res.writeHead(proxyRes.statusCode, resHeaders);
                proxyRes.pipe(res);
                proxyRes.on('error', (err) => {
                    releaseReservation();
                    log(`[token-proxy] #${reqId} upstream stream error: ${err.message}`);
                    if (!res.writableEnded) {
                        res.end();
                    }
                });
                return;
            } catch (error) {
                lastError = error;
                releaseReservation();
                log(`[token-proxy] #${reqId} Network error: ${error.message}`);
                if (tokenInfo.remoteLease) {
                    reportRemoteResult(tokenInfo, 502, requestModelKey);
                    cachedRemoteLease = null;
                } else if (prepared.authMode !== 'passthrough') {
                    quotaTracker.reportError(tokenInfo.accountId);
                }
                if (attempts <= maxRetries) continue;
            }
        }

        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'All retries exhausted', message: lastError?.message }));
    }

    function start() {
        quotaTracker.init();
        // Auto-discover projects for accounts without projectId
        tokenManager.autoDiscoverProjects().catch((err) => {
            log(`[token-proxy] Auto-discover error: ${err.message}`);
        });
        quotaPoller.start();
        server = http.createServer(handleRequest);
        server.listen(proxyPort, '127.0.0.1', () => {
            log(`[token-proxy] Proxy listening on 127.0.0.1:${proxyPort}`);
            log(`[token-proxy] → ${cloudEndpoint}`);
            log(`[token-proxy] Accounts: ${tokenManager.getEnabledCount()}`);
        });
        server.on('error', (e) => {
            log(`[token-proxy] Server error: ${e.message}`);
            quotaPoller.stop();
            quotaTracker.destroy();
            if (server) {
                try {
                    server.close();
                } catch {
                    // Ignore close errors on failed startup.
                }
                server = null;
            }
        });
        return server;
    }

    function stop() {
        quotaPoller.stop();
        quotaTracker.destroy();
        if (server) { server.close(); server = null; }
    }

    function getStatus() {
        const runtime = getRuntimeTokenMode();
        return {
            running: Boolean(server), port: proxyPort, cloudEndpoint,
            mode: runtime.mode === 'remote' ? 'token-passthrough' : 'token-proxy',
            tokenSource: runtime.mode,
            tokenServerUrl: runtime.mode === 'remote' ? runtime.tokenServerUrl : '',
            hasTokenServerSecret: runtime.mode === 'remote' ? Boolean(runtime.tokenServerSecret) : false,
            remoteLeaseCount,
            remoteReportCount,
            remoteErrorCount,
            lastRemoteError,
            remoteActiveAccountId: cachedRemoteLease?.accountId || null,
            remoteActiveEmailHint: cachedRemoteLease?.email || '',
            remoteActiveProjectId: cachedRemoteLease?.projectId || '',
            accessKeyStatus: lastAccessKeyStatus,
            totalRequests: requestCount, totalRotations: rotationCount,
            ...quotaTracker.getStatus(),
        };
    }

    function switchAccount(accountId, reason = 'manual') {
        return quotaTracker.setActiveAccount(accountId, reason);
    }

    return { start, stop, getStatus, switchAccount, tokenManager, quotaTracker, quotaPoller };
}

module.exports = {
    createTokenProxy,
    DEFAULT_CLOUD_ENDPOINT,
    decodeErrorBody,
    extractCapacityModelKey,
    extractModelKeyFromBody,
    extractQuotaResetDelayMs,
    formatProjectValue,
    isLowSignalModel,
    getRotationDetails,
    getRotationReason,
    parseDurationToMs,
    prepareForwardRequest,
    sanitizeProxyResponseHeaders,
    shouldLogPrimaryConversation,
    shouldRetryWithAnotherAccount,
    buildUnavailableAccountsResponse,
    formatRetryDelayText,
    rewriteProjectFields,
    rewriteProjectFieldsInBody,
    shouldWaitForCapacityRecovery,
};

