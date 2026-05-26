import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  readJsonFile,
  writeJsonFile,
  shouldBackupAccessKeys,
  readIntegrityHashes,
  addIntegrityHash,
  maskEmail,
  constantTimeEqual,
  isVerificationChallengeText,
  isLocationUnsupportedText,
  isPermanentTokenRefreshError,
  parseVersionParts,
  compareVersions,
} from '../data-store';

// ── Test helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-store-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── readJsonFile ─────────────────────────────────────────────────────────────

describe('readJsonFile', () => {
  it('should return {} for non-existent path', () => {
    expect(readJsonFile(path.join(tmpDir, 'nope.json'))).toEqual({});
  });

  it('should return {} for empty path', () => {
    expect(readJsonFile('')).toEqual({});
  });

  it('should parse valid JSON', () => {
    const filePath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(filePath, '{"hello":"world"}');
    expect(readJsonFile(filePath)).toEqual({ hello: 'world' });
  });

  it('should strip BOM before parsing', () => {
    const filePath = path.join(tmpDir, 'bom.json');
    fs.writeFileSync(filePath, '\uFEFF{"bom":true}');
    expect(readJsonFile(filePath)).toEqual({ bom: true });
  });

  it('should return {} for invalid JSON in non-access-keys files', () => {
    const filePath = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(filePath, 'not json {{{');
    expect(readJsonFile(filePath)).toEqual({});
  });

  it('should throw for invalid JSON in access-keys.json', () => {
    const filePath = path.join(tmpDir, 'access-keys.json');
    fs.writeFileSync(filePath, 'not json {{{');
    expect(() => readJsonFile(filePath)).toThrow('Failed to parse access-keys.json');
  });
});

// ── writeJsonFile ────────────────────────────────────────────────────────────

describe('writeJsonFile', () => {
  it('should write pretty-printed JSON with trailing newline', () => {
    const filePath = path.join(tmpDir, 'out.json');
    writeJsonFile(filePath, { key: 'value' });
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toBe('{\n  "key": "value"\n}\n');
  });

  it('should create parent directories if needed', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'out.json');
    writeJsonFile(filePath, { nested: true });
    expect(readJsonFile(filePath)).toEqual({ nested: true });
  });

  it('should overwrite existing file', () => {
    const filePath = path.join(tmpDir, 'overwrite.json');
    writeJsonFile(filePath, { v: 1 });
    writeJsonFile(filePath, { v: 2 });
    expect(readJsonFile(filePath)).toEqual({ v: 2 });
  });
});

// ── shouldBackupAccessKeys ───────────────────────────────────────────────────

describe('shouldBackupAccessKeys', () => {
  it('should return false for non-existent file', () => {
    expect(shouldBackupAccessKeys(path.join(tmpDir, 'nope.json'))).toBe(false);
  });

  it('should return false for files not named access-keys.json', () => {
    const filePath = path.join(tmpDir, 'accounts.json');
    fs.writeFileSync(filePath, '{}');
    expect(shouldBackupAccessKeys(filePath)).toBe(false);
  });

  it('should return true for access-keys.json with no recent backup', () => {
    const filePath = path.join(tmpDir, 'access-keys.json');
    fs.writeFileSync(filePath, '{}');
    expect(shouldBackupAccessKeys(filePath)).toBe(true);
  });

  it('should return false for access-keys.json with a recent backup', () => {
    const filePath = path.join(tmpDir, 'access-keys.json');
    fs.writeFileSync(filePath, '{}');
    // Create a recent backup
    const bakName = `access-keys.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(path.join(tmpDir, bakName), '{}');
    expect(shouldBackupAccessKeys(filePath)).toBe(false);
  });
});

// ── writeJsonFile + backup ───────────────────────────────────────────────────

describe('writeJsonFile backup for access-keys.json', () => {
  it('should create backup when writing to access-keys.json', () => {
    const filePath = path.join(tmpDir, 'access-keys.json');
    fs.writeFileSync(filePath, '{"keys":[]}');
    writeJsonFile(filePath, { keys: [{ id: 'new' }] });

    const files = fs.readdirSync(tmpDir);
    const backups = files.filter((f) => f.startsWith('access-keys.json.bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Integrity hashes ─────────────────────────────────────────────────────────

describe('readIntegrityHashes', () => {
  it('should return empty array when file does not exist', () => {
    expect(readIntegrityHashes(path.join(tmpDir, 'integrity.json'))).toEqual([]);
  });

  it('should return hashes array from valid file', () => {
    const filePath = path.join(tmpDir, 'integrity.json');
    fs.writeFileSync(filePath, JSON.stringify({ hashes: ['abc', 'def'] }));
    expect(readIntegrityHashes(filePath)).toEqual(['abc', 'def']);
  });

  it('should return empty array if hashes is not an array', () => {
    const filePath = path.join(tmpDir, 'integrity.json');
    fs.writeFileSync(filePath, JSON.stringify({ hashes: 'not-array' }));
    expect(readIntegrityHashes(filePath)).toEqual([]);
  });
});

describe('addIntegrityHash', () => {
  it('should create file with single hash if file does not exist', () => {
    const filePath = path.join(tmpDir, 'integrity.json');
    addIntegrityHash(filePath, 'hash1');
    expect(readIntegrityHashes(filePath)).toEqual(['hash1']);
  });

  it('should append hash to existing list', () => {
    const filePath = path.join(tmpDir, 'integrity.json');
    fs.writeFileSync(filePath, JSON.stringify({ hashes: ['hash1'] }));
    addIntegrityHash(filePath, 'hash2');
    expect(readIntegrityHashes(filePath)).toEqual(['hash1', 'hash2']);
  });

  it('should not duplicate existing hash', () => {
    const filePath = path.join(tmpDir, 'integrity.json');
    fs.writeFileSync(filePath, JSON.stringify({ hashes: ['hash1'] }));
    addIntegrityHash(filePath, 'hash1');
    expect(readIntegrityHashes(filePath)).toEqual(['hash1']);
  });
});

// ── Pure utility functions ───────────────────────────────────────────────────

describe('maskEmail', () => {
  it('should mask email address', () => {
    expect(maskEmail('alice@gmail.com')).toBe('al***@gmail.com');
  });

  it('should return *** for very short local parts', () => {
    expect(maskEmail('a@x.com')).toBe('***');
  });

  it('should return empty for empty input', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail(null as any)).toBe('');
    expect(maskEmail(undefined as any)).toBe('');
  });
});

describe('constantTimeEqual', () => {
  it('should return true for matching strings', () => {
    expect(constantTimeEqual('secret123', 'secret123')).toBe(true);
  });

  it('should return false for different strings', () => {
    expect(constantTimeEqual('secret123', 'secret456')).toBe(false);
  });

  it('should return false for different lengths', () => {
    expect(constantTimeEqual('short', 'longstring')).toBe(false);
  });

  it('should handle empty/null inputs', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual(null as any, null as any)).toBe(true);
    expect(constantTimeEqual('a', '')).toBe(false);
  });
});

describe('isVerificationChallengeText', () => {
  it('should detect Google verification challenges', () => {
    expect(isVerificationChallengeText('Please verify your account')).toBe(true);
    expect(isVerificationChallengeText('validation_required')).toBe(true);
    expect(isVerificationChallengeText('al_alert')).toBe(true);
  });

  it('should return false for normal text', () => {
    expect(isVerificationChallengeText('Hello world')).toBe(false);
    expect(isVerificationChallengeText('')).toBe(false);
    expect(isVerificationChallengeText(null as any)).toBe(false);
  });
});

describe('isLocationUnsupportedText', () => {
  it('should detect location unsupported errors', () => {
    expect(isLocationUnsupportedText('User location is not supported')).toBe(true);
    expect(isLocationUnsupportedText('FAILED_PRECONDITION: location is not supported')).toBe(true);
  });

  it('should return false for normal text', () => {
    expect(isLocationUnsupportedText('OK')).toBe(false);
  });
});

describe('isPermanentTokenRefreshError', () => {
  it('should detect permanent token errors', () => {
    expect(isPermanentTokenRefreshError('invalid_grant')).toBe(true);
    expect(isPermanentTokenRefreshError('Token has been expired or revoked')).toBe(true);
    expect(isPermanentTokenRefreshError('access_denied')).toBe(true);
    expect(isPermanentTokenRefreshError('ServiceRestricted')).toBe(true);
  });

  it('should return false for transient errors', () => {
    expect(isPermanentTokenRefreshError('timeout')).toBe(false);
    expect(isPermanentTokenRefreshError('ECONNREFUSED')).toBe(false);
  });
});

describe('parseVersionParts', () => {
  it('should parse semver-like strings', () => {
    expect(parseVersionParts('4.0.6')).toEqual([4, 0, 6]);
    expect(parseVersionParts('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersionParts('10.20.30')).toEqual([10, 20, 30]);
  });

  it('should handle edge cases', () => {
    expect(parseVersionParts('')).toEqual([0, 0, 0]);
    expect(parseVersionParts(null as any)).toEqual([0, 0, 0]);
  });
});

describe('compareVersions', () => {
  it('should compare versions correctly', () => {
    expect(compareVersions('4.0.6', '4.0.6')).toBe(0);
    expect(compareVersions('4.0.7', '4.0.6')).toBeGreaterThan(0);
    expect(compareVersions('4.0.5', '4.0.6')).toBeLessThan(0);
    expect(compareVersions('5.0.0', '4.9.9')).toBeGreaterThan(0);
    expect(compareVersions('3.9.9', '4.0.0')).toBeLessThan(0);
  });
});
