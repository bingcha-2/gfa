'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_LOG_SIZE = 512 * 1024; // 512 KB
const DEFAULT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create a logger that writes to a file with automatic rotation.
 *
 * @param {object} options
 * @param {string} options.filePath - Absolute path to the log file
 * @param {string} [options.prefix] - Line prefix (e.g. '[token-proxy]')
 * @param {number} [options.maxSize] - Max log file size in bytes before rotation (default 2MB)
 * @param {number} [options.cleanupIntervalMs] - How often to check for rotation (default 30min)
 * @returns {{ log: Function, destroy: Function }}
 */
function createLogger(options = {}) {
    const {
        filePath,
        prefix = '',
        maxSize = DEFAULT_MAX_LOG_SIZE,
        cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    } = options;

    if (!filePath) {
        return { log: console.log, destroy: () => {} };
    }

    const resolvedPath = path.resolve(filePath);
    let cleanupTimer = null;

    function rotateIfNeeded() {
        try {
            if (!fs.existsSync(resolvedPath)) {
                return;
            }
            const stats = fs.statSync(resolvedPath);
            if (stats.size < maxSize) {
                return;
            }
            // Truncate log file directly — no .old backup
            fs.writeFileSync(resolvedPath, '', 'utf8');
            // Clean up legacy .old files if they exist
            const oldPath = resolvedPath + '.old';
            if (fs.existsSync(oldPath)) {
                fs.rmSync(oldPath, { force: true });
            }
        } catch {
            // Ignore rotation errors
        }
    }

    function log(...args) {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
        const prefixPart = prefix ? ` ${prefix}` : '';
        const line = `[${ts}]${prefixPart} ${args.map((v) => String(v)).join(' ')}`;
        console.log(line);
        try {
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            fs.appendFileSync(resolvedPath, `${line}\n`, 'utf8');
        } catch {
            // Keep proxy running even if file logging fails
        }
    }

    // Start periodic rotation check
    rotateIfNeeded();
    cleanupTimer = setInterval(rotateIfNeeded, cleanupIntervalMs);
    if (cleanupTimer.unref) {
        cleanupTimer.unref();
    }

    function destroy() {
        if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }
    }

    return { log, destroy };
}

module.exports = { createLogger };
