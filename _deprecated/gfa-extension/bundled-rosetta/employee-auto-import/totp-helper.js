/**
 * TOTP helper for employee auto-import (standalone, no TypeScript dependencies).
 *
 * Uses the `crypto` built-in to generate HMAC-SHA1 based TOTP codes.
 * No external npm dependencies needed.
 */

"use strict";

const crypto = require("crypto");

// Base32 alphabet (RFC 4648)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Common OCR / manual-entry mistakes
const CHAR_FIX_MAP = { "0": "O", "1": "L", "8": "B", "9": "G" };

/**
 * Decode a Base32 string to a Buffer.
 */
function base32Decode(input) {
  const cleaned = input.replace(/[=\s-]/g, "").toUpperCase();
  let bits = "";
  for (const ch of cleaned) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid Base32 character: ${ch}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Sanitise a raw TOTP secret into strict Base32.
 */
function sanitiseBase32(raw) {
  let cleaned = raw.replace(/[\s\-=]/g, "").toUpperCase();
  cleaned = cleaned.split("").map((ch) => CHAR_FIX_MAP[ch] || ch).join("");
  if (!/^[A-Z2-7]+$/.test(cleaned)) {
    const bad = [...new Set(cleaned.split("").filter((c) => !/[A-Z2-7]/.test(c)))];
    throw new Error(`TOTP secret contains invalid Base32 characters: [${bad.join(", ")}]`);
  }
  if (cleaned.length < 16) {
    throw new Error(`TOTP secret is too short (${cleaned.length} chars). Expected ≥16.`);
  }
  return cleaned;
}

/**
 * Generate a 6-digit TOTP code from a base32-encoded secret.
 */
function generateTOTP(secret) {
  const cleanSecret = sanitiseBase32(secret);
  const key = base32Decode(cleanSecret);
  const time = Math.floor(Date.now() / 1000 / 30);

  // Time as 8-byte big-endian buffer
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
  timeBuffer.writeUInt32BE(time & 0xffffffff, 4);

  const hmac = crypto.createHmac("sha1", key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1000000).padStart(6, "0");
}

/**
 * Seconds remaining before the current TOTP code expires.
 */
function totpSecondsRemaining() {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

module.exports = { generateTOTP, totpSecondsRemaining, sanitiseBase32 };
