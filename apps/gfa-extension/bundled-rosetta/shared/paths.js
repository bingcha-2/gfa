'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Platform-aware AppData directory resolution.
// macOS:   ~/Library/Application Support
// Windows: %APPDATA%
// Linux:   $XDG_CONFIG_HOME or ~/.config
function getAppDataBase() {
    if (process.env.ROSETTA_DATA_DIR) return null; // overridden, don't resolve
    switch (process.platform) {
        case 'win32':
            return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support');
        default:
            return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    }
}

// Centralized data directory for all mutable runtime data.
// Override with ROSETTA_DATA_DIR environment variable.
const DATA_DIR = path.resolve(
    process.env.ROSETTA_DATA_DIR ||
    path.join(getAppDataBase(), 'Antigravity', 'rosetta')
);

function accountsPath() {
    return path.join(DATA_DIR, 'accounts.json');
}

function quotaDataPath() {
    return path.join(DATA_DIR, 'quota-data.json');
}

function tokenProxyLogPath() {
    return path.join(DATA_DIR, 'logs', 'token-proxy.log');
}

function tokenProxyStatePath() {
    return path.join(DATA_DIR, 'logs', 'token-proxy-state.json');
}

function reverseProxyLogPath() {
    return path.join(DATA_DIR, 'logs', 'reverse-proxy.log');
}

/**
 * Ensure the data directory and its subdirectories exist.
 * Call this during proxy bootstrap or extension activation.
 */
function ensureDataDir() {
    const dirs = [
        DATA_DIR,
        path.join(DATA_DIR, 'logs'),
        path.join(DATA_DIR, 'cache'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

module.exports = {
    DATA_DIR,
    configPath() { return path.join(DATA_DIR, 'proxy.config.json'); },
    accountsPath,
    quotaDataPath,
    tokenProxyLogPath,
    tokenProxyStatePath,
    reverseProxyLogPath,
    ensureDataDir,
};
