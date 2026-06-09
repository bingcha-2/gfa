// Server-side Anthropic (Claude) OAuth token refresh.
//
// Mirrors codex-token-provider.ts: an account carries a long-lived OAuth
// refresh_token; we exchange it for a short-lived access_token and cache the
// result on the account until it nears expiry. The endpoint/client_id are the
// Claude Code OAuth values (overridable via env so prod can correct them
// without a redeploy — the defaults are what production actually uses).
//
// Logic ported from reclaude-reverse/internal/oauth/anthropic.go (rewritten in
// TS): refresh_token grant against the Anthropic OAuth token endpoint.
//
// CONCURRENCY (the reason this file is more than a single fetch):
// Anthropic rotates (single-use) refresh tokens AND runs token-family reuse
// detection — present a refresh_token that was already consumed and the upstream
// revokes the WHOLE family, so the account dies with `invalid_grant: Refresh
// token not found or invalid` a day or two later (after the cached access_token
// finally lapses). In a multi-user pool ONE account is leased concurrently by
// many cards, so several leases hit expiry at once and fire parallel grants —
// the losers replay a consumed token and kill the family. The official
// claude-code client guards against exactly this with (a) in-flight refresh
// dedup and (b) re-read-and-adopt when another writer already rotated the token
// (see claude-code src/utils/auth.ts: pending401Handlers / pendingRefreshCheck
// and the "another tab already refreshed - use it" branch). We do the same here:
//   1. per-account single-flight — concurrent refreshes share ONE grant;
//   2. reload-before-grant + invalid_grant recovery — adopt a token another
//      path/process just persisted instead of burning a second single-use token.
//
// Proxy-aware fetch selection: when the account has an exit proxy we route through
// the installed undici's fetch so it can carry that undici's Dispatcher — Node's
// bundled fetch rejects a dispatcher from a different undici major ("invalid
// onRequestStart method"). With NO proxy we use the global fetch: it's the common
// path, the original behavior, and stays stubbable by tests (vi.stubGlobal).

import { proxyAwareFetch } from "../../lease-core/egress";

// Endpoint + client_id verified against the Claude Code 2.x binary (the current
// client posts a refresh_token grant to platform.claude.com/v1/oauth/token).
const CLAUDE_TOKEN_ENDPOINT =
  process.env.BCAI_CLAUDE_TOKEN_ENDPOINT || "https://platform.claude.com/v1/oauth/token";
// Public Claude Code OAuth client id (same value the Claude Code binary embeds).
const CLAUDE_CLIENT_ID =
  process.env.BCAI_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type ClaudeAccount = {
  id: number;
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  enabled?: boolean;
  planType?: string;
  // Sticky per-account exit proxy (residential IP). When set, the token refresh
  // is routed through it so refresh and inference share one egress IP.
  proxyUrl?: string;
  [key: string]: unknown;
};

/** Latest persisted copy of an account, re-read from disk on demand. Lets the
 * refresh path (a) skip the grant when another writer already rotated the token,
 * and (b) recover from invalid_grant by adopting that newer token instead of
 * declaring the account dead. Return null/undefined when unavailable. */
export type RefreshOptions = {
  reload?: () => ClaudeAccount | null | undefined;
};

type TokenResult = { accessToken: string; accessTokenExpiresAt: number; refreshToken: string };

/** Carries the upstream status/body so callers can distinguish a hard
 * invalid_grant (dead account → re-login) from a transient/network failure. */
export class ClaudeRefreshError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = "ClaudeRefreshError";
  }
}

/** True when the upstream rejected the refresh_token itself (consumed/rotated/
 * revoked) — as opposed to a network blip or 5xx. Such accounts cannot be saved
 * by retrying; they need a fresh OAuth login. */
export function isInvalidGrant(err: unknown): boolean {
  const body = err instanceof ClaudeRefreshError ? err.body : "";
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant|refresh token not found or invalid/i.test(`${body} ${msg}`);
}

// Per-account single-flight: concurrent refreshes for the same account await one
// shared grant instead of each firing its own (which would replay a now-consumed
// single-use refresh_token and trip Anthropic's family-reuse revocation). Keyed
// by email (present on both the lease account and the quota-refresh probe), with
// account id as a fallback.
const inFlightRefresh = new Map<string, Promise<TokenResult>>();

function refreshKey(account: ClaudeAccount): string {
  return String(account.email || account.id || "");
}

function isUsable(accessToken: unknown, expiresAt: unknown): boolean {
  return Boolean(accessToken) && Number(expiresAt || 0) > Date.now() + REFRESH_BUFFER_MS;
}

function applyResult(account: ClaudeAccount, r: TokenResult): string {
  account.accessToken = r.accessToken;
  account.accessTokenExpiresAt = r.accessTokenExpiresAt;
  if (r.refreshToken) account.refreshToken = r.refreshToken;
  return r.accessToken;
}

export async function refreshClaudeAccessToken(
  account: ClaudeAccount,
  opts: RefreshOptions = {},
): Promise<string> {
  // Fast path: this caller's own cached access token is still comfortably valid.
  if (isUsable(account.accessToken, account.accessTokenExpiresAt)) {
    return account.accessToken as string;
  }

  const key = refreshKey(account);
  if (!key) {
    // No stable identity to lock on — fall back to a direct (unlocked) refresh.
    return applyResult(account, await runRefresh(account, opts));
  }

  let inflight = inFlightRefresh.get(key);
  if (!inflight) {
    const started = runRefresh(account, opts);
    inflight = started.finally(() => {
      // Only clear if it's still ours, so we never evict a newer in-flight grant.
      if (inFlightRefresh.get(key) === inflight) inFlightRefresh.delete(key);
    });
    inFlightRefresh.set(key, inflight);
  }
  // Each concurrent caller applies the shared result to its OWN account object
  // (lease account vs quota probe are distinct instances of the same account).
  return applyResult(account, await inflight);
}

async function runRefresh(account: ClaudeAccount, opts: RefreshOptions): Promise<TokenResult> {
  // Re-read disk first: another path/process may have just rotated the token.
  // If a usable access token is already persisted, adopt it and skip the grant
  // entirely — never burn a second single-use refresh_token for the same window.
  const fresh = opts.reload?.();
  if (fresh && isUsable(fresh.accessToken, fresh.accessTokenExpiresAt)) {
    return {
      accessToken: String(fresh.accessToken),
      accessTokenExpiresAt: Number(fresh.accessTokenExpiresAt),
      refreshToken: String(fresh.refreshToken || account.refreshToken || ""),
    };
  }

  // Use the freshest refresh_token we can see — disk may be ahead of the in-memory
  // copy this caller arrived with.
  const refreshToken = String(fresh?.refreshToken || account.refreshToken || "");
  const proxyUrl = account.proxyUrl || fresh?.proxyUrl;
  if (!refreshToken) {
    throw new Error(`Claude token refresh failed for ${account.email}: missing refresh_token`);
  }

  try {
    return await grant(account.email, refreshToken, proxyUrl);
  } catch (err) {
    // invalid_grant recovery: our refresh_token was already consumed/rotated/
    // revoked. Before surfacing a dead account, re-read disk once more — another
    // writer may have persisted a usable token (the official "another tab already
    // refreshed - use it" path). Only if that ALSO has a newer refresh_token do we
    // retry the grant; otherwise the account is genuinely dead and we rethrow.
    if (isInvalidGrant(err) && opts.reload) {
      const latest = opts.reload();
      if (latest && isUsable(latest.accessToken, latest.accessTokenExpiresAt)) {
        return {
          accessToken: String(latest.accessToken),
          accessTokenExpiresAt: Number(latest.accessTokenExpiresAt),
          refreshToken: String(latest.refreshToken || refreshToken),
        };
      }
      const latestRt = String(latest?.refreshToken || "");
      if (latestRt && latestRt !== refreshToken) {
        return await grant(account.email, latestRt, proxyUrl);
      }
    }
    throw err;
  }
}

async function grant(email: string, refreshToken: string, proxyUrl?: string): Promise<TokenResult> {
  // Route through the account's exit proxy when one is set. A bad/unsupported
  // proxy URL is a hard error in proxyAwareFetch — we never fall back to a direct
  // connection, which would leak the datacenter IP and defeat the IP pinning.
  let response: Response;
  try {
    response = await proxyAwareFetch(proxyUrl, CLAUDE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new Error(`Claude token refresh failed for ${email}: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ClaudeRefreshError(
      `Claude token refresh failed for ${email}: ${response.status} ${text}`,
      response.status,
      text,
    );
  }

  const tokenData = JSON.parse(text);
  const accessToken = String(tokenData.access_token || "");
  if (!accessToken) throw new Error(`Claude token refresh failed for ${email}: missing access_token`);
  return {
    accessToken,
    accessTokenExpiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
    // Rotation: adopt the new refresh_token when returned, else keep the current
    // one (matches the official client's `newRefreshToken = refreshToken` default).
    refreshToken: tokenData.refresh_token ? String(tokenData.refresh_token) : refreshToken,
  };
}
