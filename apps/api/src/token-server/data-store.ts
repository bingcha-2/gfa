/**
 * data-store.ts — JSON file I/O, backup, integrity hashes, and pure utility functions.
 *
 * Extracted from remote-token-server/index.js (L24-L303).
 * Mostly pure / file-system-only. The one piece of in-memory state is
 * `lastBackupAtByPath`, used to decide whether an access-keys.json backup is
 * due without scanning the directory on every write (the write path is hot).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ────────────────────────────────────────────────────────────

const ACCESS_KEY_BACKUP_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_ACCESS_KEY_BACKUP_INTERVAL_MS || 60 * 60 * 1000),
);

// How many timestamped access-keys.json backups to retain. Older ones are
// pruned whenever a new backup is made (default 24 ≈ one day at hourly).
const MAX_ACCESS_KEY_BACKUPS = Math.max(
  1,
  Number(process.env.BCAI_ACCESS_KEY_MAX_BACKUPS || 24),
);

// In-memory record of the last backup time per file path, so the hot write
// path never has to scan the backup directory to decide whether a backup is
// due. Lost on restart — at most one extra backup is made after a restart,
// which is harmless (and arguably a useful checkpoint).
const lastBackupAtByPath = new Map<string, number>();

// ── JSON file I/O ────────────────────────────────────────────────────────────

/**
 * Check whether access-keys.json needs a timestamped backup, using the
 * in-memory last-backup timestamp (no directory scan).
 */
export function shouldBackupAccessKeys(filePath: string, now = Date.now()): boolean {
  if (path.basename(filePath) !== 'access-keys.json' || !fs.existsSync(filePath)) {
    return false;
  }
  const last = lastBackupAtByPath.get(filePath) || 0;
  return now - last >= ACCESS_KEY_BACKUP_INTERVAL_MS;
}

/**
 * Delete the oldest access-keys.json backups, keeping only the newest `keep`.
 * Backup names are `<file>.bak-<ISO timestamp>`, which sort lexicographically
 * in chronological order. Only invoked right after a new backup is created.
 */
function pruneAccessKeyBackups(filePath: string, keep: number): void {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.bak-`;
  try {
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort(); // ISO timestamps → lexicographic sort == oldest-first
    const toDelete = backups.slice(0, Math.max(0, backups.length - keep));
    for (const name of toDelete) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

/**
 * Read and parse a JSON file. Returns {} if the file doesn't exist or is
 * invalid JSON — except for access-keys.json which throws on parse errors.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (error: any) {
    if (path.basename(filePath) === 'access-keys.json') {
      throw new Error(`Failed to parse ${path.basename(filePath)}: ${error.message || error}`);
    }
    return {};
  }
}

/**
 * Write a JSON object to disk with pretty-printing and trailing newline.
 * Auto-creates parent directories. Backs up access-keys.json if no recent
 * backup exists.
 */
export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = Date.now();
  if (shouldBackupAccessKeys(filePath, now)) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    try {
      fs.copyFileSync(filePath, `${filePath}.bak-${stamp}`);
      lastBackupAtByPath.set(filePath, now);
      pruneAccessKeyBackups(filePath, MAX_ACCESS_KEY_BACKUPS);
    } catch { /* backup is best-effort; never block the write */ }
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ── Integrity hashes ─────────────────────────────────────────────────────────

/**
 * Read the whitelist of known-good SHA-256 hashes.
 */
export function readIntegrityHashes(filePath: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.hashes) ? data.hashes : [];
  } catch {
    return [];
  }
}

/**
 * Add a hash to the integrity whitelist if not already present.
 */
export function addIntegrityHash(filePath: string, hash: string): void {
  const hashes = readIntegrityHashes(filePath);
  if (!hashes.includes(hash)) {
    hashes.push(hash);
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify({ hashes, updatedAt: new Date().toISOString() }, null, 2),
      );
    } catch { /* best-effort */ }
  }
}

// ── Email masking ────────────────────────────────────────────────────────────

/**
 * Mask an email for safe display: "alice@gmail.com" → "al***@gmail.com"
 */
export function maskEmail(email: unknown): string {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at <= 1) return value ? '***' : '';
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}

// ── Cryptographic comparison ─────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function constantTimeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ── Error text detection ─────────────────────────────────────────────────────

/**
 * Detect Google verification challenge responses.
 */
export function isVerificationChallengeText(value: unknown): boolean {
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

/**
 * Detect "location not supported" errors from Google Cloud.
 */
export function isLocationUnsupportedText(value: unknown): boolean {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('user location is not supported') ||
    text.includes('location is not supported for the api use') ||
    (text.includes('failed_precondition') && text.includes('location') && text.includes('not supported'))
  );
}

/**
 * Detect permanent token refresh errors (account revoked, restricted, etc.).
 */
export function isPermanentTokenRefreshError(value: unknown): boolean {
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

// ── Version comparison ───────────────────────────────────────────────────────

/**
 * Parse a version string like "4.0.6" or "v1.2.3" into [major, minor, patch].
 */
export function parseVersionParts(value: unknown): number[] {
  const parts = String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const match = String(part || '').match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });
  // Ensure exactly 3 elements
  while (parts.length < 3) parts.push(0);
  return parts;
}

/**
 * Compare two version strings. Returns negative if left < right,
 * positive if left > right, zero if equal.
 */
export function compareVersions(left: unknown, right: unknown): number {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
