/**
 * epay.sign.ts — pure sign/verify logic for 彩虹易支付 (epay).
 *
 * Algorithm:
 *  1. Take all params whose value is non-empty AND key not in {sign, sign_type}.
 *  2. Sort keys by ASCII ascending.
 *  3. Join as `k=v&k=v&...` using raw values (no url-encode).
 *  4. Append the merchant KEY.
 *  5. md5 the result, lowercased.
 *
 * verifySign uses crypto.timingSafeEqual to prevent timing attacks on the
 * HMAC comparison. Unequal-length inputs (attacker controls sign length) →
 * false, no exception.
 */
import * as crypto from "crypto";

/** Sign a params object, returning the md5 hex string. */
export function signParams(params: Record<string, string>, key: string): string {
  const filtered = Object.entries(params)
    .filter(([k, v]) => v !== "" && v !== undefined && v !== null && k !== "sign" && k !== "sign_type")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const queryString = filtered.map(([k, v]) => `${k}=${v}`).join("&");
  return crypto.createHash("md5").update(queryString + key, "utf8").digest("hex").toLowerCase();
}

/**
 * Verify a params object's sign field.
 * Returns false (never throws) if the sign is missing, empty, or wrong length.
 * Uses constant-time comparison when lengths match to prevent timing attacks.
 */
export function verifySign(params: Record<string, string>, key: string): boolean {
  const expected = signParams(params, key);
  const actual = (params.sign ?? "").toLowerCase();

  // Length check is not constant-time, but leaks only length equality.
  // Unequal length → definitively wrong, short-circuit is safe.
  if (expected.length !== actual.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
  } catch {
    return false;
  }
}
