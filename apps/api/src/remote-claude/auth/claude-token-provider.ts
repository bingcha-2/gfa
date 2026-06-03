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

const CLAUDE_TOKEN_ENDPOINT =
  process.env.BCAI_CLAUDE_TOKEN_ENDPOINT || "https://console.anthropic.com/v1/oauth/token";
// Public Claude Code OAuth client id (the same value Claude Code itself uses).
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
  [key: string]: unknown;
};

export async function refreshClaudeAccessToken(account: ClaudeAccount): Promise<string> {
  if (account.accessToken && Number(account.accessTokenExpiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw new Error(`Claude token refresh failed for ${account.email}: missing refresh_token`);
  }

  const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
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
