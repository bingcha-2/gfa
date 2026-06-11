/**
 * session-credential.ts — Customer-session credential helpers for AccessKeyStore.
 *
 * Extracted from access-key-store.ts (file-size control): the cheap
 * looks-like-a-session-JWT shape check, the injected-resolver contract, and the
 * ResolveResult shaping for session-branch failures live here. The store keeps
 * only the thin branch itself — resolver call → byId lookup → shared validation
 * pipeline dispatch (see AccessKeyStore.resolveFromRequest).
 */

import type { ResolveResult } from './access-key-store';

/**
 * Resolves a customer session JWT (Authorization bearer with typ
 * "user-session") to the ACTIVE Subscription id, which doubles as the shadow
 * AccessKeyRecord id. Injected from Nest (SessionTokenResolver) via
 * AccessKeyStore.setSessionResolver — the store itself stays a plain TS class.
 */
export interface SessionResolverLike {
  resolve(
    bearerToken: string,
    opts: { product?: string },
  ): Promise<
    | { ok: true; cardId: string }
    | { ok: false; statusCode: number; error: string; message: string }
  >;
  /**
   * Optional fire-and-forget hook: a session lease just armed firstUsedAt on a
   * shadow record that carries NO absolute keyExpiresAt (i.e. a migrated
   * never-used card whose Subscription.expiresAt is still null). Receives the
   * record's now-effective expiry (firstUsedAt + durationMs) so the caller can
   * resync it onto the Subscription row. Called WITHOUT await on the lease hot
   * path — implementations must be non-blocking and swallow their own errors.
   */
  onShadowRecordFirstUse?(cardId: string, effectiveExpiresAtIso: string): void;
}

/**
 * Cheap shape check (NO signature verification): does this bearer look like a
 * customer session JWT? Three dot-segments whose payload decodes to JSON with
 * typ === "user-session". Card keys (BCAI-… / sub_… / opaque secrets) never
 * match, so the card path is untouched. Verification happens in the resolver.
 */
export function looksLikeUserSessionToken(bearer: string): boolean {
  if (!bearer) return false;
  const parts = bearer.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return !!payload && payload.typ === 'user-session';
  } catch {
    return false;
  }
}

// ── Session-branch failure shaping ───────────────────────────────────────────
// All three return a ResolveResult with viaSession: true and record: null; the
// client's fatal-error matching keys off sessionError.code where present.

/** Wiring gap (resolver not yet registered) — fail closed with a clear
 * operator-facing reason rather than misclassifying as a bad card. */
export function sessionResolverUnavailable(): ResolveResult {
  return { key: '', record: null, error: 'session resolver unavailable', viaSession: true };
}

/** Resolver rejected the token (SESSION_INVALID / DEVICE_REVOKED /
 * SUBSCRIPTION_EXPIRED …) — propagate its status + machine-readable code. */
export function sessionResolveFailure(
  failed: { statusCode: number; error: string; message: string },
): ResolveResult {
  return {
    key: '', record: null, viaSession: true,
    error: failed.message,
    sessionError: { statusCode: failed.statusCode, code: failed.error },
  };
}

/** Subscription row exists but its shadow record is missing (sync gap):
 * surface as an expired subscription so the client shows the right state. */
export function missingShadowRecord(): ResolveResult {
  return {
    key: '', record: null, viaSession: true,
    error: '无有效订阅或已到期',
    sessionError: { statusCode: 403, code: 'SUBSCRIPTION_EXPIRED' },
  };
}

/**
 * Session-resolved shadow record failed RECORD-level validation — the sub row
 * was ACTIVE (the resolver passed) but the record is expired/disabled (drift,
 * e.g. a never-used migrated card whose firstUsedAt+durationMs ran out while
 * Subscription.expiresAt is still null). Without this the client gets a bare
 * 401 "Access key expired" and can't tell "renew subscription" from "bad
 * credential" — so attach the SUBSCRIPTION_EXPIRED machine code. Quota
 * failures keep their 429 contract (limitExceeded passes through untouched),
 * successes and already-coded failures pass through unchanged. Card-key
 * lookups never route here, so the card path's generic errors are untouched.
 */
export function shadowRecordValidationFailure(result: ResolveResult): ResolveResult {
  if (result.record || result.limitExceeded || result.sessionError) return result;
  return { ...result, sessionError: { statusCode: 403, code: 'SUBSCRIPTION_EXPIRED' } };
}
