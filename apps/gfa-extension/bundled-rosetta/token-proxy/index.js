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

const logFilePath = path.resolve(fileConfig.tokenProxyLogPath || paths.tokenProxyLogPath());
const logger = createLogger({ filePath: logFilePath });

const config = {
    proxyPort: fileConfig.tokenProxyPort || 60670,
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
        res.end(JSON.stringify({ ...proxy.getStatus(), dataDir: paths.DATA_DIR }, null, 2));
    } else if (req.url === '/reload-accounts' && req.method === 'POST') {
        const handleReload = async () => {
            try {
                config.log('[reload] accounts reload requested');
                proxy.tokenManager.loadAccounts();
                await proxy.tokenManager.autoDiscoverProjects();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    status: proxy.getStatus(),
                }));
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
                res.end(JSON.stringify({
                    ok: true,
                    result: result || {},
                    status: proxy.getStatus(),
                }));
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
                res.end(JSON.stringify({
                    ok: true,
                    switched,
                    status: proxy.getStatus(),
                }));
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
