#!/usr/bin/env node
'use strict';

/**
 * Antigravity Rosetta — Token Proxy
 * Multi-account Cloud Code endpoint proxy with automatic token rotation.
 *
 * Data directory: %APPDATA%/Antigravity/rosetta/ (override with ROSETTA_DATA_DIR)
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { createTokenProxy } = require('./token-proxy');
const paths = require('../shared/paths');
const { createLogger } = require('../shared/logger');

// Ensure data directory exists before anything else
paths.ensureDataDir();

// --- Auto-migrate legacy data from project root to centralized data dir ---
function migrateFileIfNeeded(legacyPath, targetPath, label) {
    if (fs.existsSync(targetPath)) {
        return false;
    }
    if (!fs.existsSync(legacyPath)) {
        return false;
    }
    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(legacyPath, targetPath);
        console.log(`[migrate] Copied ${label} → ${targetPath}`);
        return true;
    } catch (error) {
        console.error(`[migrate] Failed to copy ${label}: ${error.message}`);
        return false;
    }
}

const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_REMOTE_TOKEN_SERVER_URL = 'https://bcai.site/remote-token';

function normalizeUrl(value) {
    return String(value || '').trim().toLowerCase().replace(/\/+$/, '');
}

function isRemoteMode(config) {
    const mode = String(
        config?.tokenProxyMode ||
        config?.tokenSource ||
        config?.relayProxy?.tokenSource ||
        'local'
    ).trim().toLowerCase();
    return mode === 'remote' || mode === 'token-passthrough' || mode === 'relay';
}

function migrateRemoteTokenUrlIfNeeded(configPath, config) {
    if (!isRemoteMode(config)) return config;
    const relay = config.relayProxy || (config.relayProxy = {});
    const current = normalizeUrl(relay.tokenServerUrl || config.remoteTokenServerUrl);
    if (current && current !== 'http://127.0.0.1:60700' && current !== 'http://localhost:60700') {
        return config;
    }
    relay.tokenServerUrl = DEFAULT_REMOTE_TOKEN_SERVER_URL;
    try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        console.log(`[migrate] Remote token URL -> ${DEFAULT_REMOTE_TOKEN_SERVER_URL}`);
    } catch (error) {
        console.error(`[migrate] Failed to update remote token URL: ${error.message}`);
    }
    return config;
}

migrateFileIfNeeded(
    path.join(projectRoot, 'accounts.json'),
    paths.accountsPath(),
    'accounts.json'
);
migrateFileIfNeeded(
    path.join(projectRoot, 'quota-data.json'),
    paths.quotaDataPath(),
    'quota-data.json'
);
migrateFileIfNeeded(
    path.join(projectRoot, 'proxy.config.json'),
    paths.configPath(),
    'proxy.config.json'
);

// --- Load config from centralized path (AppData), fall back to project root ---
let fileConfig = {};
const centralConfigPath = paths.configPath();
if (fs.existsSync(centralConfigPath)) {
    try { fileConfig = JSON.parse(fs.readFileSync(centralConfigPath, 'utf8')); } catch { /* defaults */ }
} else if (fs.existsSync(path.join(projectRoot, 'proxy.config.json'))) {
    try { fileConfig = require('../proxy.config.json'); } catch { /* defaults */ }
} else {
    // Fresh install: create default config from example
    const examplePath = path.join(projectRoot, 'proxy.config.example.json');
    if (fs.existsSync(examplePath)) {
        try {
            fs.mkdirSync(path.dirname(centralConfigPath), { recursive: true });
            fs.copyFileSync(examplePath, centralConfigPath);
            fileConfig = JSON.parse(fs.readFileSync(centralConfigPath, 'utf8'));
            console.log(`[init] Created default config → ${centralConfigPath}`);
        } catch { /* defaults */ }
    }
}

fileConfig = migrateRemoteTokenUrlIfNeeded(centralConfigPath, fileConfig);

const logFilePath = path.resolve(fileConfig.tokenProxyLogPath || paths.tokenProxyLogPath());
const logger = createLogger({ filePath: logFilePath });

const config = {
    proxyPort: fileConfig.tokenProxyPort || 60670,
    configPath: centralConfigPath,
    accountsFilePath: fileConfig.accountsFilePath || paths.accountsPath(),
    cloudEndpoint: fileConfig.googleCloudEndpoint || undefined,
    cooldownMs: fileConfig.tokenProxyCooldownMs || 60000,
    maxRetries: fileConfig.tokenProxyMaxRetries || 3,
    runtimeLogPath: logFilePath,
    runtimeStatePath: path.resolve(fileConfig.tokenProxyStatePath || paths.tokenProxyStatePath()),
    log: logger.log,
};

console.log('=== Antigravity Rosetta — Token Proxy ===');
console.log(`Port:     ${config.proxyPort}`);
console.log(`Data:     ${paths.DATA_DIR}`);
console.log(`Accounts: ${path.resolve(config.accountsFilePath)}`);
console.log(`Target:   ${config.cloudEndpoint || '(default)'}`);
console.log(`Log:      ${config.runtimeLogPath}`);
console.log('');

const proxy = createTokenProxy(config);
const proxyServer = proxy.start();

if (proxyServer) {
    proxyServer.on('error', (error) => {
        if (error && error.code === 'EADDRINUSE') {
            config.log('[fatal] proxy port already in use, exiting');
            process.exit(1);
        }
    });
}

config.log(`[bootstrap] pid=${process.pid}`);

// ─── Outbound connectivity test (5-layer smart probe) ───────────────────────
const https = require('https');
const { execSync } = require('child_process');

const outboundState = {
    tested: false,
    success: false,
    error: '',
    proxyUsed: '',
    layer: -1,
};

function probeGoogle(proxyUrl, timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    return new Promise((resolve, reject) => {
        if (proxyUrl) {
            const proxyParsed = new URL(proxyUrl);
            const connectReq = http.request({
                host: proxyParsed.hostname,
                port: Number(proxyParsed.port) || 80,
                method: 'CONNECT',
                path: 'generativelanguage.googleapis.com:443',
            });
            connectReq.setTimeout(timeoutMs, () => { connectReq.destroy(); reject(new Error('PROXY_TIMEOUT')); });
            connectReq.on('error', reject);
            connectReq.on('connect', (res, socket) => {
                if (res.statusCode !== 200) { socket.destroy(); reject(new Error('CONNECT_' + res.statusCode)); return; }
                const tlsReq = https.request({
                    host: 'generativelanguage.googleapis.com', path: '/', method: 'HEAD',
                    socket: socket, agent: false,
                }, (tlsRes) => { socket.destroy(); resolve(tlsRes.statusCode); });
                tlsReq.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('TLS_TIMEOUT')); });
                tlsReq.on('error', (err) => { socket.destroy(); reject(err); });
                tlsReq.end();
            });
            connectReq.end();
        } else {
            const req = https.request({
                host: 'generativelanguage.googleapis.com', path: '/', method: 'HEAD', timeout: timeoutMs,
            }, (res) => { resolve(res.statusCode); });
            req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('DIRECT_TIMEOUT')); });
            req.on('error', reject);
            req.end();
        }
    });
}

function readWindowsSystemProxy() {
    if (process.platform !== 'win32') return '';
    try {
        const enabledRaw = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        if (!enabledRaw.includes('0x1')) return '';
        const serverRaw = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        const match = serverRaw.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
        if (!match) return '';
        const val = match[1].trim();
        return val.startsWith('http') ? val : 'http://' + val;
    } catch { return ''; }
}

async function runOutboundTest() {
    const layers = [];
    const userProxy = String(process.env.BCAI_USER_PROXY || '').trim();
    if (userProxy) layers.push({ name: 'user_proxy', proxy: userProxy });
    layers.push({ name: 'direct', proxy: '' });
    const ideProxy = String(process.env.BCAI_IDE_PROXY || '').trim();
    if (ideProxy) layers.push({ name: 'ide_proxy', proxy: ideProxy });
    const regProxy = readWindowsSystemProxy();
    if (regProxy) layers.push({ name: 'registry_proxy', proxy: regProxy });
    const envProxy = String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '').trim();
    if (envProxy && envProxy !== ideProxy && envProxy !== userProxy) layers.push({ name: 'env_proxy', proxy: envProxy });

    config.log(`[outbound] testing ${layers.length} layers: ${layers.map(l => l.name + '=' + (l.proxy || '(direct)')).join(', ')}`);

    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        try {
            const code = await probeGoogle(layer.proxy, 6000);
            config.log(`[outbound] layer ${i} (${layer.name}) OK: HTTP ${code}`);
            outboundState.tested = true;
            outboundState.success = true;
            outboundState.proxyUsed = layer.proxy;
            outboundState.layer = i;
            outboundState.error = '';
            return;
        } catch (err) {
            config.log(`[outbound] layer ${i} (${layer.name}) FAILED: ${err.message || err}`);
        }
    }
    config.log('[outbound] all layers failed');
    outboundState.tested = true;
    outboundState.success = false;
    outboundState.error = '所有探测层均失败，Node 引擎无法连接 Google';
    outboundState.layer = -1;
}

runOutboundTest().catch((err) => {
    config.log(`[outbound] test crashed: ${err.message || err}`);
    outboundState.tested = true;
    outboundState.success = false;
    outboundState.error = err.message || String(err);
});

process.on('uncaughtException', (error) => {
    config.log(`[fatal] uncaughtException: ${error.stack || error.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const message = reason && reason.stack ? reason.stack : String(reason);
    config.log(`[fatal] unhandledRejection: ${message}`);
    process.exit(1);
});

process.on('SIGINT', () => {
    config.log('[shutdown] SIGINT');
    logger.destroy();
    proxy.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    config.log('[shutdown] SIGTERM');
    logger.destroy();
    proxy.stop();
    process.exit(0);
});

// Status API on port+1
const STATUS_PORT = config.proxyPort + 1;
const statusServer = http.createServer((req, res) => {
    if (req.url === '/status' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...proxy.getStatus(), outbound: outboundState, dataDir: paths.DATA_DIR }, null, 2));
    } else if (req.url === '/reload-accounts' && req.method === 'POST') {
        const handleReload = async () => {
            try {
                config.log('[reload] accounts reload requested');
                proxy.tokenManager.loadAccounts();
                await proxy.tokenManager.autoDiscoverProjects();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, status: proxy.getStatus() }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error.message }));
            }
        };
        req.resume();
        void handleReload();
    } else if (req.url === '/refresh-quota' && req.method === 'POST') {
        const handleRefresh = async () => {
            try {
                config.log('[quota] manual refresh requested');
                const result = await proxy.quotaPoller.pollNow();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, result: result || {}, status: proxy.getStatus() }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error.message }));
            }
        };
        req.resume();
        void handleRefresh();
    } else if (req.url === '/switch-account' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                const payload = raw ? JSON.parse(raw) : {};
                const accountId = Number(payload.accountId);
                if (!Number.isFinite(accountId) || accountId <= 0) {
                    throw new Error('Invalid accountId');
                }
                const switched = proxy.switchAccount(accountId, 'manual');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, switched }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error.message }));
            }
        });
        req.on('error', (error) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error.message }));
        });
    } else if (req.url === '/set-debug-mode' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                const payload = raw ? JSON.parse(raw) : {};
                const enabled = Boolean(payload.enabled);
                const result = proxy.setDebugMode(enabled);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, debugMode: result }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error.message }));
            }
        });
        req.on('error', (error) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error.message }));
        });
    } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});
statusServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        config.log(`[fatal] status port ${STATUS_PORT} already in use, exiting`);
        process.exit(1);
    } else {
        console.error('[status] Server error:', e.message);
    }
});
statusServer.listen(STATUS_PORT, '127.0.0.1', () => {
    console.log(`[status] http://127.0.0.1:${STATUS_PORT}/status`);
});
