'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const DEFAULT_REMOTE_ROTATION_ATTEMPTS = 2;
const MAX_REMOTE_ROTATION_ATTEMPTS = 99;
const CLIENT_VERSION_FALLBACK = '4.0.7';
const REMOTE_ACCESS_KEY_FAILURE_COOLDOWN_MS = 60 * 1000;
const LOCATION_UNSUPPORTED_COOLDOWN_MS = 5 * 60 * 1000;
const TOKEN_USAGE_CAPTURE_LIMIT = 2 * 1024 * 1024;

// ── Self-integrity verification ──────────────────────────────────────────────
// Compute SHA-256 of this file at startup. Sent to the server with every
// lease/report request so the server can detect tampered client code.
const _integrityHash = (() => {
    try {
        const selfPath = __filename;
        const content = fs.readFileSync(selfPath, 'utf8');
        return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
        return 'unknown';
    }
})();

function readPositiveIntEnv(name, fallback) {
    const value = Number.parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function remoteRetryDelayMs(attempts, retryPolicy = null) {
    const retryIndex = Math.max(0, Number(attempts || 1) - 1);
    const policy = normalizeRemoteRetryPolicy(retryPolicy);
    // 指数退避：base * multiplier^retryIndex + jitter
    const exponential = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, retryIndex);
    const jitter = Math.random() * policy.jitterMs;
    return Math.min(policy.maxDelayMs, exponential + jitter);
}

function remoteStatusDelayMs(status, attempts, retryPolicy = null) {
    const policy = normalizeRemoteRetryPolicy(retryPolicy);
    const baseRetry = remoteRetryDelayMs(attempts, retryPolicy);
    if (status === 503) {
        return Math.max(baseRetry, policy.capacityWaitMs);
    }
    if (status === 429) {
        return Math.max(baseRetry, policy.quotaWaitMs);
    }
    return baseRetry;
}

function normalizeRemoteRetryPolicy(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const maxAttempts = Math.min(
        MAX_REMOTE_ROTATION_ATTEMPTS,
        Math.max(1, Number(raw.maxAttempts || DEFAULT_REMOTE_ROTATION_ATTEMPTS) || DEFAULT_REMOTE_ROTATION_ATTEMPTS)
    );
    const retryableStatuses = Array.isArray(raw.retryableStatuses)
        ? raw.retryableStatuses.map((item) => Number(item)).filter((item) => Number.isFinite(item))
        : [429, 403, 503];
    return {
        maxAttempts,
        baseDelayMs: Math.max(0, Number(raw.baseDelayMs || 250) || 250),
        maxDelayMs: Math.max(500, Number(raw.maxDelayMs || 5000) || 5000),
        backoffMultiplier: Math.max(1.0, Math.min(3.0, Number(raw.backoffMultiplier || 1.3) || 1.3)),
        capacityWaitMs: Math.max(200, Number(raw.capacityWaitMs || 2000) || 2000),
        quotaWaitMs: Math.max(200, Number(raw.quotaWaitMs || 1000) || 1000),
        jitterMs: Math.max(0, Number(raw.jitterMs || 500) || 500),
        retryableStatuses,
        statusMaxAttempts: raw.statusMaxAttempts && typeof raw.statusMaxAttempts === 'object'
            ? Object.fromEntries(Object.entries(raw.statusMaxAttempts)
                .map(([status, attempts]) => [Number(status), Number(attempts)])
                .filter(([status, attempts]) => Number.isFinite(status) && Number.isFinite(attempts) && attempts > 0)
                .map(([status, attempts]) => [
                    status,
                    Math.min(MAX_REMOTE_ROTATION_ATTEMPTS, Math.max(1, attempts)),
                ]))
            : {},
        reason: String(raw.reason || 'client_default'),
        pressureUntil: Number(raw.pressureUntil || 0) || 0,
    };
}

function makeLocalClientId() {
    return `client_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

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

function isSchemaNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return (
        Object.prototype.hasOwnProperty.call(value, 'type') ||
        Object.prototype.hasOwnProperty.call(value, 'description') ||
        Object.prototype.hasOwnProperty.call(value, 'properties') ||
        Object.prototype.hasOwnProperty.call(value, 'required') ||
        Object.prototype.hasOwnProperty.call(value, 'items') ||
        Object.prototype.hasOwnProperty.call(value, 'enum')
    );
}

function isSchemaPropertiesMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).some(isSchemaNode);
}

function rewriteProjectFields(value, projectId, context = {}) {
    if (!value || typeof value !== 'object') {
        return { found: 0, updated: 0 };
    }

    let found = 0;
    let updated = 0;

    if (Array.isArray(value)) {
        for (const item of value) {
            const child = rewriteProjectFields(item, projectId, context);
            found += child.found;
            updated += child.updated;
        }
        return { found, updated };
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'project') {
            if (context.inSchemaProperties && isSchemaNode(childValue)) {
                continue;
            }

            found += 1;
            const nextValue = formatProjectValue(childValue, projectId);
            if (nextValue !== childValue) {
                value[key] = nextValue;
                updated += 1;
            }
            continue;
        }

        if (childValue && typeof childValue === 'object') {
            const child = rewriteProjectFields(childValue, projectId, {
                inSchemaProperties: key === 'properties' && isSchemaPropertiesMap(childValue),
            });
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

    // 注入 enabledCreditTypes: GOOGLE_ONE_AI（默认消耗积分）
    const credits = Array.isArray(parsed.enabledCreditTypes) ? parsed.enabledCreditTypes : [];
    if (!credits.includes('GOOGLE_ONE_AI') && !credits.includes(1)) {
        parsed.enabledCreditTypes = [...credits, 'GOOGLE_ONE_AI'];
        return {
            body: Buffer.from(JSON.stringify(parsed)),
            projectFound: rewrite.found > 0 || rewrite.updated > 0,
            projectUpdated: true,
        };
    }

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
    } else if (!fwdHeaders.authorization && tokenInfo.token) {
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

function readTokenCount(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function discountedCachedTokens(cachedTokens) {
    const count = readTokenCount(cachedTokens);
    return count > 0 ? Math.ceil(count / 10) : 0;
}

function sumTokenDetails(value) {
    if (!Array.isArray(value)) return 0;
    return value.reduce((sum, item) => sum + readTokenCount(item?.tokenCount || item?.tokens), 0);
}

function addTokenUsage(total, usage) {
    if (!usage || typeof usage !== 'object') return false;
    const inputTokens = readTokenCount(usage.promptTokenCount) ||
        readTokenCount(usage.inputTokenCount) ||
        readTokenCount(usage.promptTokens) ||
        readTokenCount(usage.inputTokens);
    let outputTokens = readTokenCount(usage.candidatesTokenCount) ||
        readTokenCount(usage.outputTokenCount) ||
        readTokenCount(usage.completionTokens) ||
        readTokenCount(usage.outputTokens);
    const thoughtTokens = readTokenCount(usage.thoughtsTokenCount);
    const totalTokens = readTokenCount(usage.totalTokenCount) || readTokenCount(usage.totalTokens);
    const cachedInputTokens = Math.min(
        inputTokens,
        readTokenCount(usage.cachedContentTokenCount) ||
        readTokenCount(usage.cachedPromptTokenCount) ||
        readTokenCount(usage.cacheTokenCount) ||
        readTokenCount(usage.cachedInputTokens) ||
        sumTokenDetails(usage.cacheTokensDetails)
    );

    if (thoughtTokens > 0) {
        outputTokens += thoughtTokens;
    }
    if (totalTokens > 0 && inputTokens > 0) {
        outputTokens = Math.max(outputTokens, totalTokens - inputTokens);
    }
    if (inputTokens <= 0 && outputTokens <= 0) return false;

    const rawTotalTokens = totalTokens || inputTokens + outputTokens;
    const billableTotalTokens = cachedInputTokens > 0
        ? Math.max(0, rawTotalTokens - cachedInputTokens + discountedCachedTokens(cachedInputTokens))
        : rawTotalTokens;

    total.inputTokens += inputTokens;
    total.outputTokens += outputTokens;
    total.cachedInputTokens += cachedInputTokens;
    total.rawTotalTokens += rawTotalTokens;
    total.totalTokens += billableTotalTokens;
    return true;
}

function createEmptyTokenUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        rawTotalTokens: 0,
        totalTokens: 0,
    };
}

function mergeCumulativeTokenUsage(total, usage) {
    if (!usage || typeof usage !== 'object') return total;
    total.inputTokens = Math.max(total.inputTokens, readTokenCount(usage.inputTokens));
    total.outputTokens = Math.max(total.outputTokens, readTokenCount(usage.outputTokens));
    total.cachedInputTokens = Math.max(total.cachedInputTokens, readTokenCount(usage.cachedInputTokens));
    total.rawTotalTokens = Math.max(total.rawTotalTokens, readTokenCount(usage.rawTotalTokens));
    total.totalTokens = Math.max(total.totalTokens, readTokenCount(usage.totalTokens));
    return total;
}

function collectTokenUsage(value, total = createEmptyTokenUsage()) {
    if (!value || typeof value !== 'object') {
        return total;
    }

    if (Array.isArray(value)) {
        for (const item of value) collectTokenUsage(item, total);
        return total;
    }

    if (value.usageMetadata && typeof value.usageMetadata === 'object') {
        addTokenUsage(total, value.usageMetadata);
    }
    if (value.usage && typeof value.usage === 'object') {
        addTokenUsage(total, value.usage);
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            collectTokenUsage(child, total);
        }
    }
    return total;
}

function parseTokenUsagePayload(text) {
    const raw = String(text || '').trim();
    if (!raw || raw === '[DONE]') {
        return createEmptyTokenUsage();
    }
    try {
        return collectTokenUsage(JSON.parse(raw));
    } catch {
        return createEmptyTokenUsage();
    }
}

function findLastTokenField(text, fieldNames) {
    const names = fieldNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`"(${names})"\\s*:\\s*(\\d+)`, 'g');
    let value = 0;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
        value = readTokenCount(match[2]) || value;
    }
    return value;
}

function extractTokenUsageByRegex(text) {
    const inputTokens = findLastTokenField(text, [
        'promptTokenCount',
        'inputTokenCount',
        'promptTokens',
        'inputTokens',
    ]);
    let outputTokens = findLastTokenField(text, [
        'candidatesTokenCount',
        'outputTokenCount',
        'completionTokens',
        'outputTokens',
    ]);
    const thoughtTokens = findLastTokenField(text, ['thoughtsTokenCount']);
    const totalTokens = findLastTokenField(text, ['totalTokenCount', 'totalTokens']);
    const cachedInputTokens = Math.min(inputTokens, findLastTokenField(text, [
        'cachedContentTokenCount',
        'cachedPromptTokenCount',
        'cacheTokenCount',
        'cachedInputTokens',
    ]));

    if (thoughtTokens > 0) {
        outputTokens += thoughtTokens;
    }
    if (totalTokens > 0 && inputTokens > 0) {
        outputTokens = Math.max(outputTokens, totalTokens - inputTokens);
    }
    const rawTotalTokens = totalTokens || inputTokens + outputTokens;
    const billableTotalTokens = cachedInputTokens > 0
        ? Math.max(0, rawTotalTokens - cachedInputTokens + discountedCachedTokens(cachedInputTokens))
        : rawTotalTokens;
    return {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        rawTotalTokens,
        totalTokens: billableTotalTokens,
    };
}

function extractTokenUsageFromText(text) {
    const direct = parseTokenUsagePayload(text);
    if (direct.inputTokens > 0 || direct.outputTokens > 0) {
        return direct;
    }

    const total = createEmptyTokenUsage();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('data:')) {
            line = line.slice(5).trim();
        }
        const usage = parseTokenUsagePayload(line);
        mergeCumulativeTokenUsage(total, usage);
    }
    if (total.inputTokens > 0 || total.outputTokens > 0) {
        return total;
    }
    return extractTokenUsageByRegex(text);
}

function createTokenUsageCapture(limit = TOKEN_USAGE_CAPTURE_LIMIT) {
    const chunks = [];
    let bytes = 0;

    return {
        push(chunk) {
            if (!chunk) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            if (buffer.length > limit) {
                chunks.length = 0;
                chunks.push(buffer.subarray(buffer.length - limit));
                bytes = limit;
                return;
            }
            chunks.push(buffer);
            bytes += buffer.length;
            while (bytes > limit && chunks.length > 0) {
                const first = chunks[0];
                const overflow = bytes - limit;
                if (first.length <= overflow) {
                    chunks.shift();
                    bytes -= first.length;
                } else {
                    chunks[0] = first.subarray(overflow);
                    bytes -= overflow;
                }
            }
        },
        read() {
            if (chunks.length === 0) return null;
            return Buffer.concat(chunks, bytes);
        },
    };
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

function getRequestPath(reqUrl) {
    try {
        return new URL(reqUrl, 'http://127.0.0.1').pathname;
    } catch {
        return String(reqUrl || '').split('?')[0] || '/';
    }
}

function hasUsableAuthorization(headers) {
    const value = headers?.authorization || headers?.Authorization || '';
    return /^Bearer\s+\S+/i.test(String(value || '').trim());
}

function shouldLogRemoteDiagnostic(reqUrl, runtimeUsesRemoteToken, isGenerationRequest) {
    if (!runtimeUsesRemoteToken) {
        return false;
    }
    return isGenerationRequest || isIdeAccountSetupRequest(reqUrl);
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

function isIdeAccountSetupRequest(reqUrl) {
    const url = String(reqUrl || '');
    return url.includes(':loadCodeAssist') ||
        url.includes(':onboardUser') ||
        url.includes(':fetchAdminControls') ||
        url.includes(':fetchAvailableModels') ||
        url.includes('fetchAvailableModels') ||
        url.includes('/undefined') ||
        url.includes('fetchUserInfo') ||
        url.includes('cascadeNuxes');
}

function isGenerateContentRequest(reqUrl) {
    const url = String(reqUrl || '');
    return url.includes(':streamGenerateContent') ||
        url.includes(':generateContent') ||
        url.includes('streamGenerateContent') ||
        url.includes('generateContent');
}

function sendJsonResponse(res, statusCode, payload) {
    const body = JSON.stringify(payload || {});
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function maybeMockRemoteIdeRequest(req, res, reqId, runtimeUsesRemoteToken, isGenerationRequest, log, configPath, accountsFilePath) {
    if (!runtimeUsesRemoteToken || isGenerationRequest) {
        return false;
    }

    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;

    // ── loadCodeAssist, onboardUser, fetchAdminControls: PASSTHROUGH ──
    // These MUST hit Google with the IDE's own bearer token so the IDE
    // receives the real cloudaicompanionProject, tier info, and operation
    // structure.  Previous mocks returned a fake project name which caused
    // fetchAdminControls → 400 and onboardUser → missing 'name' field →
    // IDE polling /v1internal/undefined → 404, permanently blocking init.
    if (pathname.includes(':loadCodeAssist') ||
        pathname.includes(':onboardUser') ||
        pathname.includes(':fetchAdminControls')) {
        log(`[token-proxy] #${reqId} [PASSTHROUGH] ${pathname.split(':').pop()} (transparent)`);
        return false;
    }

    // Safety net: catch the /undefined URL that older broken mocks caused
    if (pathname === '/v1internal/undefined' || pathname.endsWith('/undefined')) {
        log(`[token-proxy] #${reqId} [MOCK] undefined endpoint`);
        sendJsonResponse(res, 200, {});
        return true;
    }

    // fetchAvailableModels: serve from cache when available, otherwise passthrough
    if (pathname.includes(':fetchAvailableModels') || pathname.includes('fetchAvailableModels')) {
        const cachedModelsPayload = loadCachedAvailableModelsPayload(configPath, accountsFilePath);
        if (hasAvailableModelsPayload(cachedModelsPayload)) {
            log(`[token-proxy] #${reqId} [MOCK] fetchAvailableModels`);
            sendJsonResponse(res, 200, cachedModelsPayload);
            return true;
        }
        log(`[token-proxy] #${reqId} [MOCK-SKIP] fetchAvailableModels no cached models; passthrough`);
        return false;
    }

    return false;
}

function createPassthroughTokenInfo() {
    return {
        token: '',
        accountId: 0,
        email: 'ide-passthrough',
        projectId: '',
        canRotate: false,
        reservation: null,
        remoteLease: false,
        passthroughOnly: true,
    };
}

function loadCachedAvailableModelsPayload(configPath, accountsFilePath) {
    const candidateDirs = [
        configPath ? path.dirname(configPath) : '',
        accountsFilePath ? path.dirname(accountsFilePath) : '',
        process.cwd(),
    ].filter(Boolean);

    for (const dir of candidateDirs) {
        const quotaDataPath = path.join(dir, 'quota-data.json');
        try {
            if (!fs.existsSync(quotaDataPath)) {
                continue;
            }
            const quotaData = JSON.parse(fs.readFileSync(quotaDataPath, 'utf8'));
            const records = Object.values(quotaData || {});
            for (const record of records) {
                const parsed = typeof record?.modelsJson === 'string'
                    ? JSON.parse(record.modelsJson)
                    : record?.modelsJson;
                if (parsed && parsed.models && !Array.isArray(parsed.models) && typeof parsed.models === 'object') {
                    return parsed;
                }
            }
        } catch {
            // Fall through to the next candidate or the empty valid payload.
        }
    }

    return null;
}

function hasAvailableModelsPayload(payload) {
    return Boolean(
        payload &&
        payload.models &&
        !Array.isArray(payload.models) &&
        typeof payload.models === 'object' &&
        Object.keys(payload.models).length > 0
    );
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
        if (statusCode === 400 && isLocationUnsupportedText(errorText)) {
            return {
                reason: 'location_unsupported',
                modelKey: extractCapacityModelKey(errorText) || String(fallbackModelKey || '').trim(),
                retryAfterMs: LOCATION_UNSUPPORTED_COOLDOWN_MS,
            };
        }
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

function isLocationUnsupportedText(value) {
    const text = String(value || '').toLowerCase();
    if (!text) return false;
    return (
        text.includes('user location is not supported') ||
        text.includes('location is not supported for the api use') ||
        (text.includes('failed_precondition') && text.includes('location') && text.includes('not supported'))
    );
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
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        return raw.trim() ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeJsonFile(filePath, value) {
    if (!filePath) return;
    fs.writeFileSync(filePath, `${JSON.stringify(value || {}, null, 2)}\n`, 'utf8');
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
    const remoteOnlyClientBuild = String(process.env.BCAI_DISTRIBUTION || '').trim().toLowerCase() === 'client';

    let server = null;
    let requestCount = 0;
    let rotationCount = 0;
    let cachedRemoteLease = null;
    let remoteLeaseCount = 0;
    let remoteReportCount = 0;
    let remoteErrorCount = 0;
    let lastRemoteError = null;
    let lastAccessKeyStatus = null;
    let remoteAuthBlockedUntil = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const inFlightRemoteLeases = new Map();
    const fallbackRemoteClientId = `token-proxy-${process.env.COMPUTERNAME || process.env.HOSTNAME || 'local'}`;

    function recordTokenUsage(capture, headers) {
        const rawBody = capture?.read?.();
        if (!rawBody) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const decodedText = decodeErrorBody(rawBody, headers?.['content-encoding'], -1);
        const usage = extractTokenUsageFromText(decodedText);
        usage.totalTokens = readTokenCount(usage.totalTokens) || usage.inputTokens + usage.outputTokens;
        if (usage.inputTokens <= 0 && usage.outputTokens <= 0 && usage.totalTokens <= 0) {
            return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        return usage;
    }

    function getRemoteRotatableCount() {
        const configured = Math.min(
            MAX_REMOTE_ROTATION_ATTEMPTS,
            readPositiveIntEnv('GFA_REMOTE_ROTATION_ATTEMPTS', DEFAULT_REMOTE_ROTATION_ATTEMPTS)
        );
        const policy = normalizeRemoteRetryPolicy(cachedRemoteLease?.retryPolicy);
        if (cachedRemoteLease?.retryPolicy) {
            return Math.min(configured, policy.maxAttempts);
        }
        const stats = cachedRemoteLease?.candidateStats || {};
        const availableForModel = Number(
            stats.healthyForModel ||
            stats.availableForModel ||
            0
        );
        // Keep remote retries low; service retryPolicy can tighten this further.
        if (availableForModel > 0) {
            return Math.max(1, Math.min(configured, availableForModel));
        }
        return Math.max(1, configured);
    }

    function shouldRetryRemoteStatus(tokenInfo, status, attempts, maxAttempts) {
        if (!tokenInfo?.remoteLease) return false;
        const policy = normalizeRemoteRetryPolicy(tokenInfo.retryPolicy);
        const statusLimit = Number(policy.statusMaxAttempts?.[Number(status)] || 0);
        const effectiveMaxAttempts = Math.max(maxAttempts, statusLimit || policy.maxAttempts);
        if (attempts >= effectiveMaxAttempts) return false;
        return policy.retryableStatuses.includes(Number(status));
    }

    function shouldRetryRemoteError(tokenInfo, status, attempts, maxAttempts, rotation) {
        if (!tokenInfo?.remoteLease) return false;
        if (Number(status) === 400 && rotation?.reason === 'location_unsupported') {
            const policy = normalizeRemoteRetryPolicy(tokenInfo.retryPolicy);
            const effectiveMaxAttempts = Math.max(maxAttempts, policy.maxAttempts);
            return attempts < effectiveMaxAttempts;
        }
        return shouldRetryRemoteStatus(tokenInfo, status, attempts, maxAttempts);
    }

    function remoteStatusMaxAttempts(tokenInfo, status, fallbackMaxAttempts) {
        const policy = normalizeRemoteRetryPolicy(tokenInfo?.retryPolicy);
        const statusLimit = Number(policy.statusMaxAttempts?.[Number(status)] || 0);
        return Math.min(
            MAX_REMOTE_ROTATION_ATTEMPTS,
            Math.max(1, fallbackMaxAttempts, policy.maxAttempts, statusLimit || 0)
        );
    }

    function getRuntimeTokenMode() {
        const runtimeConfig = readJsonFile(configPath, {});
        const mode = String(
            runtimeConfig.tokenProxyMode ||
            runtimeConfig.tokenSource ||
            runtimeConfig.relayProxy?.tokenSource ||
            'local'
        ).trim().toLowerCase();
        const relay = runtimeConfig.relayProxy || {};
        if (!relay.clientId) {
            runtimeConfig.relayProxy = relay;
            relay.clientId = makeLocalClientId();
            try {
                writeJsonFile(configPath, runtimeConfig);
            } catch (error) {
                log(`[token-proxy] failed to persist remote clientId: ${error.message}`);
                relay.clientId = fallbackRemoteClientId;
            }
        }
        return {
            mode: mode === 'remote' || mode === 'token-passthrough' || mode === 'relay'
                ? 'remote'
                : 'local',
            tokenServerUrl: String(relay.tokenServerUrl || runtimeConfig.remoteTokenServerUrl || '').trim(),
            tokenServerSecret: String(relay.tokenServerSecret || relay.apiKey || runtimeConfig.remoteTokenServerSecret || '').trim(),
            tokenServerSessionId: String(relay.sessionId || runtimeConfig.remoteTokenServerSessionId || '').trim(),
            clientId: String(relay.clientId || fallbackRemoteClientId).trim(),
            clientVersion: String(process.env.BCAI_EXTENSION_VERSION || relay.clientVersion || runtimeConfig.clientVersion || CLIENT_VERSION_FALLBACK).trim(),
            clientDistribution: String(process.env.BCAI_DISTRIBUTION || relay.clientDistribution || runtimeConfig.clientDistribution || '').trim(),
        };
    }

    function saveRemoteSessionId(sessionId) {
        const cleanSessionId = String(sessionId || '').trim();
        if (!cleanSessionId) return;
        const runtimeConfig = readJsonFile(configPath, {});
        const relay = runtimeConfig.relayProxy || {};
        if (relay.sessionId === cleanSessionId) return;
        runtimeConfig.relayProxy = relay;
        relay.sessionId = cleanSessionId;
        try {
            writeJsonFile(configPath, runtimeConfig);
        } catch (error) {
            log(`[token-proxy] failed to persist remote sessionId: ${error.message}`);
        }
    }

    async function getRemoteToken(modelKey, force = false, options = {}) {
        const runtime = getRuntimeTokenMode();
        if (!runtime.tokenServerUrl) {
            throw new Error('Remote token mode is enabled but relayProxy.tokenServerUrl is not configured.');
        }
        if (remoteAuthBlockedUntil > Date.now()) {
            const waitSeconds = Math.ceil((remoteAuthBlockedUntil - Date.now()) / 1000);
            const error = new Error(`Remote token access key was rejected; retrying in ${waitSeconds}s`);
            error.statusCode = 401;
            throw error;
        }
        const excludeAccountIds = Array.isArray(options.excludeAccountIds) ? options.excludeAccountIds : [];
        const cachedExcluded = cachedRemoteLease?.accountId && excludeAccountIds.includes(Number(cachedRemoteLease.accountId));
        if (!force && !cachedExcluded && !shouldRefreshLease(cachedRemoteLease)) {
            log(`[token-proxy] remote lease cache hit account=#${cachedRemoteLease.accountId || '?'} project=${cachedRemoteLease.projectId || '(none)'}`);
            return cachedRemoteLease;
        }
        const leaseKey = JSON.stringify({
            modelKey: String(modelKey || ''),
            force: Boolean(force),
            excludeAccountIds: excludeAccountIds
                .map((item) => Number(item))
                .filter((item) => Number.isFinite(item))
                .sort((a, b) => a - b),
        });
        const existingLease = inFlightRemoteLeases.get(leaseKey);
        if (existingLease) {
            log(`[token-proxy] remote lease join model=${modelKey || '(empty)'} force=${force ? 'yes' : 'no'}`);
            return existingLease;
        }
        const leasePromise = requestRemoteTokenLease(runtime, modelKey, force, options, excludeAccountIds);
        inFlightRemoteLeases.set(leaseKey, leasePromise);
        try {
            return await leasePromise;
        } finally {
            inFlightRemoteLeases.delete(leaseKey);
        }
    }

    async function requestRemoteTokenLease(runtime, modelKey, force, options, excludeAccountIds) {
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
                {
                    modelKey,
                    reason: 'token-proxy-remote-mode',
                    clientId: runtime.clientId,
                    clientVersion: runtime.clientVersion,
                    clientDistribution: runtime.clientDistribution,
                    sessionId: runtime.tokenServerSessionId,
                    attemptSessionId: options.attemptSessionId || '',
                    excludeAccountIds,
                    bodyBytes: options.bodyBytes || 0,
                    isGeneration: options.isGeneration !== false,
                    integrityHash: _integrityHash,
                },
                runtime.tokenServerSecret
            );
        } catch (error) {
            remoteErrorCount++;
            lastRemoteError = error.message;
            if (error.statusCode === 401 || error.statusCode === 403) {
                cachedRemoteLease = null;
                remoteAuthBlockedUntil = Date.now() + REMOTE_ACCESS_KEY_FAILURE_COOLDOWN_MS;
            }
            log(
                `[token-proxy] remote lease failed status=${error.statusCode || 'n/a'} ` +
                `error=${error.message} body=${String(error.responseBody || '').slice(0, 300)}`
            );
            throw error;
        }
        lease._leasedAt = Date.now();
        saveRemoteSessionId(lease.accessKeySessionId || lease.sessionId);
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
            probation: Boolean(lease.probation),
            candidateStats: lease.candidateStats || null,
            retryPolicy: normalizeRemoteRetryPolicy(lease.retryPolicy),
        };
        remoteLeaseCount++;
        lastRemoteError = null;
        remoteAuthBlockedUntil = 0;
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
            inputTokens: readTokenCount(details.tokenUsage?.inputTokens),
            outputTokens: readTokenCount(details.tokenUsage?.outputTokens),
            cachedInputTokens: readTokenCount(details.tokenUsage?.cachedInputTokens),
            rawTotalTokens: readTokenCount(details.tokenUsage?.rawTotalTokens),
            totalTokens: readTokenCount(details.tokenUsage?.totalTokens),
            errorText: getErrorSnippet(details.errorText || details.errText || details.message),
            integrityHash: _integrityHash,
        }, runtime.tokenServerSecret, 10000).then((result) => {
            if (result?.accessKeyStatus) {
                lastAccessKeyStatus = result.accessKeyStatus;
            }
            return result;
        }).catch((error) => {
            remoteErrorCount++;
            lastRemoteError = error.message;
            log(`[token-proxy] remote report failed: ${error.message}`);
        });
    }

    function forwardRequest(method, reqPath, headers, body, timeoutMs = 60000) {
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
            proxyReq.setTimeout(timeoutMs, () => {
                proxyReq.destroy(new Error(`upstream response timeout (${Math.ceil(timeoutMs / 1000)}s)`));
            });
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
        const isGenerationRequest = isGenerateContentRequest(req.url);
        const shouldLogConversation = shouldLogPrimaryConversation(req.url, requestModelKey);

        // Request entry log removed — response line is sufficient


        let attempts = 0;
        let lastError = null;
        const attemptedAccountIds = new Set();
        let accumulatedWaitMs = 0;
        const runtimeUsesRemoteToken = getRuntimeTokenMode().mode === 'remote';
        // In remote/relay mode the proxy is now a stable transparent gateway:
        // IDE setup, model-list, auth, count-token, and other non-generation
        // calls keep the IDE's original Authorization and go straight to Google.
        // Only actual generation calls lease a remote token and rewrite project.
        const requestUsesRemoteToken = runtimeUsesRemoteToken && isGenerationRequest;
        const requestUsesTransparentPassthrough = runtimeUsesRemoteToken && !isGenerationRequest;
        const remoteAttemptSessionId = `${Date.now()}-${reqId}`;
        const shouldLogRemoteDiag = shouldLogRemoteDiagnostic(req.url, runtimeUsesRemoteToken, isGenerationRequest);
        if (shouldLogRemoteDiag) {
            log(
                `[token-proxy] #${reqId} [diag] inbound path=${getRequestPath(req.url)} ` +
                `method=${req.method || 'GET'} model=${requestModelKey || '(none)'} ` +
                `generation=${isGenerationRequest ? 'yes' : 'no'} remoteMode=${runtimeUsesRemoteToken ? 'yes' : 'no'} ` +
                `branch=${requestUsesRemoteToken ? 'remote-token' : requestUsesTransparentPassthrough ? 'passthrough' : 'local'} ` +
                `authHeader=${hasUsableAuthorization(req.headers) ? 'bearer' : 'missing'} bodyBytes=${reqBody.length}`
            );
        }

        if (maybeMockRemoteIdeRequest(
            req,
            res,
            reqId,
            runtimeUsesRemoteToken,
            isGenerationRequest,
            log,
            configPath,
            accountsFilePath
        )) {
            return;
        }

        // Allow enough attempts to try ALL rotatable accounts for quota/capacity rotation,
        // not just maxRetries (which is meant for network errors).
        const rotatableCount = requestUsesRemoteToken ? getRemoteRotatableCount() : quotaTracker.getStatus().rotatableAccounts;
        const isDebugMode = !runtimeUsesRemoteToken && quotaTracker.isDebugMode();
        let maxAttempts = requestUsesTransparentPassthrough
            ? 1
            : isDebugMode ? 0 : (requestUsesRemoteToken ? rotatableCount : Math.max(maxRetries, rotatableCount));

        while ((requestUsesRemoteToken || requestUsesTransparentPassthrough) ? attempts < maxAttempts : attempts <= maxAttempts) {
            attempts++;
            let tokenInfo;
            try {
                if (requestUsesRemoteToken) {
                    tokenInfo = await getRemoteToken(requestModelKey, attempts > 1, {
                        attemptSessionId: remoteAttemptSessionId,
                        excludeAccountIds: Array.from(attemptedAccountIds),
                        bodyBytes: reqBody.length,
                        isGeneration: isGenerationRequest,
                    });
                    maxAttempts = Math.max(attempts, normalizeRemoteRetryPolicy(tokenInfo.retryPolicy).maxAttempts);
                } else if (requestUsesTransparentPassthrough) {
                    tokenInfo = createPassthroughTokenInfo();
                } else {
                    tokenInfo = await quotaTracker.getActiveToken({
                        modelKey: requestModelKey,
                        balanceLoad: isGenerationRequest,
                        trackInFlight: isGenerationRequest,
                        requireProjectId: isGenerationRequest,
                    });
                }
                if (tokenInfo.accountId) {
                    attemptedAccountIds.add(tokenInfo.accountId);
                }
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

                log(`[token-proxy] #${reqId} No token path=${getRequestPath(req.url)}: ${error.message}`);
                if (requestUsesRemoteToken && error.statusCode === 409) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Access key is already active on another device',
                        message: error.message,
                    }));
                    return;
                }
                if (
                    requestUsesRemoteToken &&
                    (error.statusCode === 502 || error.statusCode === 503 || error.statusCode === 504) &&
                    attempts < maxAttempts
                ) {
                    lastError = error;
                    cachedRemoteLease = null;
                    await new Promise((r) => setTimeout(r, remoteStatusDelayMs(error.statusCode, attempts, cachedRemoteLease?.retryPolicy)));
                    continue;
                }
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
            if (shouldLogRemoteDiag) {
                log(
                    `[token-proxy] #${reqId} [diag] forward path=${getRequestPath(req.url)} ` +
                    `authMode=${prepared.authMode} tokenSource=${tokenInfo.remoteLease ? 'remote-lease' : tokenInfo.passthroughOnly ? 'passthrough' : 'local-account'} ` +
                    `account=${tokenInfo.accountId || '-'} project=${tokenInfo.projectId || '-'} ` +
                    `forwardAuth=${hasUsableAuthorization(prepared.headers) ? 'bearer' : 'missing'} ` +
                    `projectUpdated=${prepared.projectUpdated ? 'yes' : 'no'}`
                );
            }

            try {
                const upstreamHeaderTimeoutMs = isGenerationRequest
                    ? requestUsesRemoteToken ? 90000 : 180000
                    : 30000;
                const proxyRes = await forwardRequest(
                    req.method,
                    req.url,
                    prepared.headers,
                    prepared.body,
                    upstreamHeaderTimeoutMs
                );

                if (shouldLogConversation || proxyRes.statusCode >= 400) {
                    log(
                        `[token-proxy] #${reqId} → ${proxyRes.statusCode} ` +
                        `(${tokenInfo.email}, auth=${prepared.authMode}` +
                        (prepared.projectUpdated ? ', project=updated' : '') +
                        ')'
                    );
                }
                if (shouldLogRemoteDiag) {
                    log(
                        `[token-proxy] #${reqId} [diag] response path=${getRequestPath(req.url)} ` +
                        `status=${proxyRes.statusCode} authMode=${prepared.authMode} ` +
                        `remoteLease=${tokenInfo.remoteLease ? 'yes' : 'no'}`
                    );
                }

                if (proxyRes.statusCode === 429) {
                    const errChunks = [];
                    for await (const c of proxyRes) errChunks.push(c);
                    const rawErr = Buffer.concat(errChunks);
                    const errText = decodeErrorBody(rawErr, proxyRes.headers['content-encoding']);
                    releaseReservation();

                    // Debug mode: passthrough 429 directly, no rotation/retry
                    if (isDebugMode) {
                        log(`[token-proxy] #${reqId} DEBUG 429 passthrough (${tokenInfo.email}): ${errText.substring(0, 500)}`);
                        const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, { bodyLength: rawErr.length });
                        res.writeHead(proxyRes.statusCode, resHeaders);
                        res.end(rawErr);
                        return;
                    }

                    const rotation = getRotationDetails(
                        proxyRes.statusCode,
                        prepared.authMode,
                        errText,
                        requestModelKey
                    );
                    rotation.errorText = errText;
                    await reportRemoteResult(tokenInfo, proxyRes.statusCode, rotation.modelKey || requestModelKey, rotation);
                    if (shouldRetryRemoteStatus(tokenInfo, proxyRes.statusCode, attempts, maxAttempts)) {
                        maxAttempts = remoteStatusMaxAttempts(tokenInfo, proxyRes.statusCode, maxAttempts);
                        cachedRemoteLease = null;
                        log(`[token-proxy] #${reqId} remote 429; refreshing lease and retrying...`);
                        await new Promise((r) => setTimeout(r, remoteStatusDelayMs(proxyRes.statusCode, attempts, tokenInfo.retryPolicy)));
                        continue;
                    }
                    if (tokenInfo.remoteLease) {
                        log(`[token-proxy] #${reqId} remote ERROR 429 path=${getRequestPath(req.url)}: ${errText.substring(0, 500)}`);
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
                            await new Promise((r) => setTimeout(r, remoteStatusDelayMs(proxyRes.statusCode, attempts, tokenInfo.retryPolicy)));
                            continue;
                        }
                    }

                    log(`[token-proxy] #${reqId} ERROR 429 path=${getRequestPath(req.url)}: ${errText.substring(0, 500)}`);
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
                    if (shouldLogRemoteDiag) {
                        log(
                            `[token-proxy] #${reqId} [diag] error-body path=${getRequestPath(req.url)} ` +
                            `status=${proxyRes.statusCode} snippet=${errText.substring(0, 300).replace(/\s+/g, ' ')}`
                        );
                    }

                    // Debug mode: passthrough all errors directly
                    if (isDebugMode) {
                        log(`[token-proxy] #${reqId} DEBUG ${proxyRes.statusCode} passthrough (${tokenInfo.email}): ${errText.substring(0, 500)}`);
                        const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, { bodyLength: rawErr.length });
                        res.writeHead(proxyRes.statusCode, resHeaders);
                        res.end(rawErr);
                        return;
                    }

                    const rotation = getRotationDetails(
                        proxyRes.statusCode,
                        prepared.authMode,
                        errText,
                        requestModelKey
                    );
                    rotation.errorText = errText;
                    if (
                        tokenInfo.remoteLease &&
                        shouldRetryRemoteError(tokenInfo, proxyRes.statusCode, attempts, maxAttempts, rotation)
                    ) {
                        await reportRemoteResult(tokenInfo, proxyRes.statusCode, rotation.modelKey || requestModelKey, rotation);
                        maxAttempts = remoteStatusMaxAttempts(tokenInfo, proxyRes.statusCode, maxAttempts);
                        cachedRemoteLease = null;
                        const retryReason = rotation.reason ? ` ${rotation.reason}` : '';
                        log(`[token-proxy] #${reqId} remote ${proxyRes.statusCode}${retryReason}; refreshing lease and retrying...`);
                        await new Promise((r) => setTimeout(r, remoteStatusDelayMs(proxyRes.statusCode, attempts, tokenInfo.retryPolicy)));
                        continue;
                    }
                    if (tokenInfo.remoteLease) {
                        await reportRemoteResult(tokenInfo, proxyRes.statusCode, rotation.modelKey || requestModelKey, rotation);
                        if (proxyRes.statusCode === 403 && isVerificationChallengeText(errText)) {
                            cachedRemoteLease = null;
                            log(`[token-proxy] #${reqId} remote verification challenge exhausted; returning temporary unavailable`);
                            sendJsonResponse(res, 503, {
                                ok: false,
                                code: 'REMOTE_TOKEN_TEMPORARILY_UNAVAILABLE',
                                error: 'Remote token account is temporarily unavailable. Please retry.',
                                message: '临时续杯账号暂不可用，请稍后重试。',
                                retryable: true,
                                upstreamStatus: proxyRes.statusCode,
                            });
                            return;
                        }
                        log(`[token-proxy] #${reqId} remote ERROR ${proxyRes.statusCode} path=${getRequestPath(req.url)}: ${errText.substring(0, 500)}`);
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

                    log(`[token-proxy] #${reqId} ERROR ${proxyRes.statusCode} path=${getRequestPath(req.url)}: ${errText.substring(0, 500)}`);
                    const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
                        bodyLength: rawErr.length,
                    });
                    res.writeHead(proxyRes.statusCode, resHeaders);
                    res.end(rawErr);
                    return;
                }

                const isStreaming = req.url.includes('streamGenerate') ||
                    String(proxyRes.headers['content-type'] || '').includes('text/event-stream');

                if (!tokenInfo.remoteLease && !isStreaming && prepared.authMode !== 'passthrough') {
                    quotaTracker.reportSuccess(tokenInfo.accountId, {
                        modelKey: requestModelKey,
                    });
                }

                const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, { isStreaming });
                let responseBytes = 0;
                let responseEnded = false;
                let clientClosed = false;
                let streamReportedFailure = false;

                const shouldInterceptBody = !tokenInfo.passthroughOnly &&
                    Math.floor(proxyRes.statusCode / 100) === 2 &&
                    (req.url.includes('fetchUserInfo') || req.url.includes('cascadeNuxes') || req.url.includes('fetchAvailableModels'));
                const bodyChunks = [];
                const tokenUsageCapture = tokenInfo.remoteLease ? createTokenUsageCapture() : null;

                // Stream timeout with socket-health-aware grace periods.
                // Phase 1 (first byte): long timeout for model thinking.
                // Phase 2 (mid-stream): when timer fires, check TCP socket health:
                //   - Socket alive → model likely still thinking, grant grace period.
                //   - Max total idle reached → force end to prevent infinite waiting.
                let streamInactivityTimer = null;
                const STREAM_FIRST_BYTE_MS = 180000; // 3 min for initial thinking
                const STREAM_MID_CHECK_MS = 60000; // 60s: first mid-stream health check
                const STREAM_GRACE_MS = 30000; // 30s per grace extension when socket alive
                const isThinkingModel = /thinking|think/i.test(requestModelKey);
                const STREAM_MAX_IDLE_MS = isLowSignalModel(requestModelKey) ? 30000
                    : isThinkingModel ? 10 * 60 * 1000 : 5 * 60 * 1000;
                const canWriteSseKeepalive = isStreaming &&
                    String(proxyRes.headers['content-type'] || '').includes('text/event-stream');
                let streamHasData = false;
                let lastDataAt = Date.now();

                const forceEndStream = (reason) => {
                    if (streamReportedFailure) return;
                    streamReportedFailure = true;
                    releaseReservation();
                    log(`[token-proxy] #${reqId} stream end: ${reason}`);
                    if (tokenInfo.remoteLease) {
                        reportRemoteResult(tokenInfo, 504, requestModelKey, {
                            reason: 'stream_timeout',
                            errorText: reason,
                        });
                        cachedRemoteLease = null;
                    } else if (prepared.authMode === 'account') {
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

                    // Check TCP socket for diagnostics only. Some Node/Windows
                    // combinations mark the socket unreadable during long model
                    // stalls even though the HTTP stream has not emitted end/error.
                    const socket = proxyRes.socket;
                    const socketAlive = socket
                        && !socket.destroyed
                        && socket.readable
                        && !proxyRes.complete;

                    if (totalIdleMs >= STREAM_MAX_IDLE_MS) {
                        forceEndStream(`max idle ${Math.ceil(totalIdleMs / 1000)}s (limit=${STREAM_MAX_IDLE_MS / 1000}s)`);
                        return;
                    }

                    // Socket alive + under max idle → model still thinking, grant grace
                    const remaining = STREAM_MAX_IDLE_MS - totalIdleMs;
                    const nextCheck = Math.min(STREAM_GRACE_MS, remaining);
                    if (canWriteSseKeepalive && !res.writableEnded) {
                        try {
                            res.write(`: bcai-keepalive ${Date.now()}\n\n`);
                        } catch (_) {
                            // Ignore keepalive write failures; normal close/error
                            // handlers below will clean up the stream.
                        }
                    }
                    if (shouldLogConversation) {
                        log(
                            `[token-proxy] #${reqId} stream idle ${Math.ceil(totalIdleMs / 1000)}s, ` +
                            `socket=${socketAlive ? 'alive' : 'quiet'}, grace +${Math.ceil(nextCheck / 1000)}s`
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
                    if (tokenUsageCapture) {
                        tokenUsageCapture.push(chunk);
                    }
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
                                    ', marking account for rotation and aborting stream'
                                );
                                if (tokenInfo.remoteLease) {
                                    rotation.tokenUsage = {
                                        inputTokens: Math.max(0, Math.floor((reqBody.length || 0) / 4)),
                                        outputTokens: Math.max(0, Math.floor((responseBytes || 0) / 5))
                                    };
                                    reportRemoteResult(tokenInfo, status, rotation.modelKey || requestModelKey, rotation);
                                    cachedRemoteLease = null;
                                } else if (prepared.authMode === 'account') {
                                    quotaTracker.reportQuotaExhausted(tokenInfo.accountId, {
                                        reason: rotation.reason,
                                        modelKey: rotation.modelKey || requestModelKey,
                                        retryAfterMs: rotation.retryAfterMs,
                                    });
                                }
                                
                                releaseReservation();
                                if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
                                proxyRes.destroy();
                                if (!res.writableEnded) res.end();
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
                    let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
                    if (tokenUsageCapture && !streamReportedFailure) {
                        tokenUsage = recordTokenUsage(tokenUsageCapture, proxyRes.headers);
                    }
                    if (!streamReportedFailure) {
                        if (tokenInfo.remoteLease) {
                            reportRemoteResult(tokenInfo, proxyRes.statusCode || 200, requestModelKey, { tokenUsage });
                        } else if (isStreaming && prepared.authMode !== 'passthrough') {
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
        const initialRuntime = getRuntimeTokenMode();
        if (!remoteOnlyClientBuild && initialRuntime.mode !== 'remote') {
            quotaTracker.init();
            // Auto-discover projects for accounts without projectId
            tokenManager.autoDiscoverProjects().catch((err) => {
                log(`[token-proxy] Auto-discover error: ${err.message}`);
            });
            quotaPoller.start();
        } else if (initialRuntime.mode === 'remote') {
            log('[token-proxy] remote token mode: local account discovery and quota poller disabled');
        } else {
            log('[token-proxy] client distribution: local account discovery and quota poller disabled');
        }
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
            clientVersion: runtime.clientVersion,
            clientDistribution: runtime.clientDistribution,
            pid: process.pid,
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
            totalInputTokens,
            totalOutputTokens,
            totalRequests: requestCount,
            totalErrors: runtime.mode === 'remote' ? remoteErrorCount : 0,
            totalRotations: rotationCount,
            ...quotaTracker.getStatus(),
        };
    }

    function switchAccount(accountId, reason = 'manual') {
        return quotaTracker.setActiveAccount(accountId, reason);
    }

    function setDebugMode(enabled) {
        const result = quotaTracker.setDebugMode(enabled);
        if (result) {
            quotaPoller.stop();
            log('[token-proxy] debug mode: quota poller paused');
        } else {
            const runtime = getRuntimeTokenMode();
            if (!remoteOnlyClientBuild && runtime.mode !== 'remote') {
                quotaPoller.start();
                log('[token-proxy] debug mode off: quota poller resumed');
            }
        }
        return result;
    }

    return { start, stop, getStatus, switchAccount, setDebugMode, tokenManager, quotaTracker, quotaPoller };
}

module.exports = {
    createTokenProxy,
    DEFAULT_CLOUD_ENDPOINT,
    decodeErrorBody,
    extractCapacityModelKey,
    extractTokenUsageFromText,
    extractModelKeyFromBody,
    extractQuotaResetDelayMs,
    formatProjectValue,
    isLowSignalModel,
    getRotationDetails,
    getRotationReason,
    parseDurationToMs,
    prepareForwardRequest,
    sanitizeProxyResponseHeaders,
    createTokenUsageCapture,
    collectTokenUsage,
    shouldLogPrimaryConversation,
    shouldRetryWithAnotherAccount,
    buildUnavailableAccountsResponse,
    formatRetryDelayText,
    rewriteProjectFields,
    rewriteProjectFieldsInBody,
    shouldWaitForCapacityRecovery,
};

