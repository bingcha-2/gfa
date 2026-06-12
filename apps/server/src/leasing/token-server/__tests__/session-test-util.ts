/**
 * session-test-util.ts — shared helpers for driving the lease engine through
 * the SESSION-JWT credential in specs (the card-string runtime credential was
 * removed; the session JWT is the only way to lease).
 *
 * Not a spec file — vitest only collects files matching the .spec.ts pattern.
 */

import type { SessionResolverLike } from '../access-key-store';

const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/**
 * Unsigned JWT-shaped token that looksLikeUserSessionToken() accepts.
 * Carries the target shadow-record/card id in the payload so the stub
 * resolver below can map token → record without external state.
 */
export function fakeSessionJwt(cardId: string, extra: Record<string, unknown> = {}): string {
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ typ: 'user-session', sub: 'cust-1', cardId, ...extra })}.sig`;
}

/** Request whose only credential is a session JWT bound to `cardId`. */
export function sessionReqFor(cardId: string): { headers: { authorization: string } } {
  return { headers: { authorization: `Bearer ${fakeSessionJwt(cardId)}` } };
}

/**
 * Stub SessionTokenResolver: trusts the token's `cardId` claim (specs control
 * both sides). Mirrors the production contract — {ok:true, cardId} routes the
 * store to its byId lookup + shared validateRecord pipeline.
 */
export const cardIdSessionResolver: SessionResolverLike = {
  async resolve(bearerToken: string) {
    try {
      const payload = JSON.parse(Buffer.from(bearerToken.split('.')[1], 'base64url').toString('utf8'));
      return { ok: true as const, cardId: String(payload?.cardId || '') };
    } catch {
      return { ok: false as const, statusCode: 401, error: 'SESSION_INVALID', message: 'bad token' };
    }
  },
};

/**
 * Wire the cardId stub resolver into a LeaseService-like object's internal
 * AccessKeyStore and return it (services build the store privately).
 */
export function withSessionResolver<T>(service: T): T {
  (service as any).accessKeyStore.setSessionResolver(cardIdSessionResolver);
  return service;
}
