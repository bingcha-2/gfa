import { proxyAwareFetch } from "../../lease-core/egress";

const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type CodexAccount = {
  id: number;
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  enabled?: boolean;
  planType?: string;
  // Optional sticky per-account exit proxy (residential IP). When set, the token
  // refresh is routed through it so refresh and inference share one egress IP.
  proxyUrl?: string;
  [key: string]: unknown;
};

export async function refreshCodexAccessToken(account: CodexAccount): Promise<string> {
  if (account.accessToken && Number(account.accessTokenExpiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw new Error(`Codex token refresh failed for ${account.email}: missing refresh_token`);
  }

  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    scope: "openid profile email",
  });

  // Route through the account's exit proxy when one is set (same egress IP as
  // inference). A bad/unsupported proxy URL throws rather than silently going
  // direct from the datacenter IP.
  let response: Response;
  try {
    response = await proxyAwareFetch(account.proxyUrl, CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new Error(`Codex token refresh failed for ${account.email}: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex token refresh failed for ${account.email}: ${response.status} ${text}`);
  }

  const tokenData = JSON.parse(text);
  const accessToken = String(tokenData.access_token || "");
  if (!accessToken) throw new Error(`Codex token refresh failed for ${account.email}: missing access_token`);
  account.accessToken = accessToken;
  account.accessTokenExpiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
  if (tokenData.refresh_token) account.refreshToken = String(tokenData.refresh_token);
  return accessToken;
}
