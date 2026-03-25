/**
 * TOTP utility for generating Google Authenticator codes.
 *
 * Uses the `otpauth` library to generate time-based one-time passwords
 * from a base32-encoded secret key stored in Account.totpSecret.
 */

import * as OTPAuth from "otpauth";

/**
 * Generate a TOTP code from a base32-encoded secret.
 * @param secret - Base32-encoded TOTP secret key (from Google Authenticator setup)
 * @returns 6-digit TOTP code string
 */
export function generateTOTP(secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: "Google",
    label: "Account",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
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
