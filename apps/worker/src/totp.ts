/**
 * TOTP utility for generating Google Authenticator codes.
 *
 * Uses the `otpauth` library to generate time-based one-time passwords
 * from a base32-encoded secret key stored in Account.totpSecret.
 */

import * as OTPAuth from "otpauth";

/** Valid Base32 alphabet (RFC 4648) */
const BASE32_CHARS = /^[A-Z2-7]+$/;

/**
 * Common OCR / manual-entry mistakes: digits that look like letters.
 * Applied before validation so slightly-wrong secrets still work.
 */
const CHAR_FIX_MAP: Record<string, string> = {
  "0": "O",
  "1": "L",
  "8": "B",
  "9": "G",
};

/**
 * Sanitise and normalise a raw TOTP secret into strict Base32.
 *
 * 1. Strip whitespace, hyphens, padding (`=`)
 * 2. Upper-case
 * 3. Apply common look-alike substitutions (0→O, 1→L, 8→B, 9→G)
 * 4. Validate against the Base32 alphabet; throw a descriptive error on failure
 *
 * @param raw   - The secret as stored in the database
 * @param label - Optional context (e.g. email) for error messages
 * @returns     - Cleaned Base32 string ready for OTPAuth
 */
export function sanitiseBase32(raw: string, label?: string): string {
  let cleaned = raw.replace(/[\s\-=]/g, "").toUpperCase();

  // Fix common look-alike characters
  cleaned = cleaned
    .split("")
    .map((ch) => CHAR_FIX_MAP[ch] ?? ch)
    .join("");

  if (!BASE32_CHARS.test(cleaned)) {
    const bad = [...new Set(cleaned.split("").filter((c) => !/[A-Z2-7]/.test(c)))];
    const ctx = label ? ` (account: ${label})` : "";
    throw new Error(
      `TOTP secret contains invalid Base32 characters: [${bad.join(", ")}]${ctx}. ` +
        `Base32 allows only A-Z and 2-7. Please fix the totpSecret in the database.`
    );
  }

  if (cleaned.length < 16) {
    const ctx = label ? ` (account: ${label})` : "";
    throw new Error(
      `TOTP secret is too short (${cleaned.length} chars)${ctx}. Expected ≥16 Base32 characters.`
    );
  }

  return cleaned;
}

/**
 * Generate a TOTP code from a base32-encoded secret.
 * @param secret - Base32-encoded TOTP secret key (from Google Authenticator setup)
 * @param label  - Optional context (e.g. login email) for error messages
 * @returns 6-digit TOTP code string
 */
export function generateTOTP(secret: string, label?: string): string {
  const cleanSecret = sanitiseBase32(secret, label);

  const totp = new OTPAuth.TOTP({
    issuer: "Google",
    label: "Account",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(cleanSecret),
  });

  return totp.generate();
}

/**
 * Check how many seconds remain before the current TOTP code expires.
 * Useful for deciding whether to wait for a fresh code.
 * @returns seconds remaining (0-29)
 */
export function totpSecondsRemaining(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

/**
 * Per-secret tracker for the last TOTP time window that was submitted.
 * Google rejects reuse of the same TOTP code within the same 30s period,
 * so callers must ensure they wait for a new window before re-submitting.
 *
 * Keyed by the first 8 chars of the secret to avoid storing full secrets
 * in memory while still isolating concurrent/sequential accounts.
 */
const _lastUsedWindows = new Map<string, number>();

function _currentWindow(): number {
  return Math.floor(Date.now() / 1000 / 30);
}

function _secretKey(secret: string): string {
  // Normalise before truncating so different formatting of the same secret
  // (e.g. "JBSW Y3DP" vs "jbswy3dp") always maps to the same key.
  return secret.replace(/[\s\-=]/g, "").toUpperCase().slice(0, 8);
}

/** Mark the current 30s window as "used" for this secret after submitting. */
export function markTotpUsed(secret: string): void {
  _lastUsedWindows.set(_secretKey(secret), _currentWindow());
}

/** True if a TOTP code from the current 30s window was already submitted for this secret. */
export function isTotpWindowUsed(secret: string): boolean {
  return _lastUsedWindows.get(_secretKey(secret)) === _currentWindow();
}
