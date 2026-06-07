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
// Proxy-aware fetch selection: when the account has an exit proxy we route through
// the installed undici's fetch so it can carry that undici's Dispatcher — Node's
// bundled fetch rejects a dispatcher from a different undici major ("invalid
// onRequestStart method"). With NO proxy we use the global fetch: it's the common
// path, the original behavior, and stays stubbable by tests (vi.stubGlobal).

import { fetch as undiciFetch } from "undici";

import { proxyDispatcherFor } from "./proxy-dispatcher";

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

export async function refreshClaudeAccessToken(account: ClaudeAccount): Promise<string> {
  if (account.accessToken && Number(account.accessTokenExpiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw new Error(`Claude token refresh failed for ${account.email}: missing refresh_token`);
  }

  // Route through the account's exit proxy when one is set. A bad/unsupported
  // proxy URL is a hard error here — we never fall back to a direct connection,
  // which would leak the datacenter IP and defeat the whole point of pinning.
  let dispatcher;
  try {
    dispatcher = proxyDispatcherFor(account.proxyUrl);
  } catch (err) {
    throw new Error(`Claude token refresh failed for ${account.email}: ${(err as Error).message}`);
  }

  const init: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  };
  // Proxy set → installed-undici fetch (carries the Dispatcher). No proxy → global
  // fetch (common path; also keeps the tests' fetch stub effective).
  if (dispatcher) init.dispatcher = dispatcher;
  const fetchImpl = (dispatcher ? undiciFetch : fetch) as typeof fetch;
  const response = await fetchImpl(CLAUDE_TOKEN_ENDPOINT, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Claude token refresh failed for ${account.email}: ${response.status} ${text}`);
  }

  const tokenData = JSON.parse(text);
  const accessToken = String(tokenData.access_token || "");
  if (!accessToken) throw new Error(`Claude token refresh failed for ${account.email}: missing access_token`);
  account.accessToken = accessToken;
  account.accessTokenExpiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
  if (tokenData.refresh_token) account.refreshToken = String(tokenData.refresh_token);
  return accessToken;
}
