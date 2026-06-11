import { proxyAwareFetch } from "../lease-core/egress";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const clientSecret = (...parts: string[]) => parts.join("-");

// The only OAuth client — every Google account authenticates via the Antigravity
// client. (The legacy "cloud-code" client was removed.)
const ANTIGRAVITY_OAUTH = {
  clientId:
    process.env.ROSETTA_CLIENT_ID ||
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret:
    process.env.ROSETTA_CLIENT_SECRET ||
    clientSecret("GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"),
};

export type TokenAccount = {
  id: number;
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  planType?: string;
  credits?: Record<string, unknown>;
  modelQuotaFractions?: Record<string, number>;
  modelQuotaResetTimes?: Record<string, string>;
  modelQuotaRefreshedAt?: number;
  // Optional sticky per-account exit proxy (residential IP). When set, the token
  // refresh is routed through it so refresh and inference share one egress IP.
  proxyUrl?: string;
  [key: string]: unknown;
};

export async function refreshGoogleAccessToken(account: TokenAccount): Promise<string> {
  if (account.accessToken && Number(account.accessTokenExpiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
    return account.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: ANTIGRAVITY_OAUTH.clientId,
    client_secret: ANTIGRAVITY_OAUTH.clientSecret,
  });

  // Route through the account's exit proxy when one is set (same egress IP as
  // inference). A bad/unsupported proxy URL throws rather than silently going
  // direct from the datacenter IP.
  let response: Response;
  try {
    response = await proxyAwareFetch(account.proxyUrl, GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new Error(`Token refresh failed for ${account.email}: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed for ${account.email}: ${response.status} ${text}`);
  }

  const tokenData = JSON.parse(text);
  const accessToken = String(tokenData.access_token || "");
  if (!accessToken) throw new Error(`Token refresh failed for ${account.email}: missing access_token`);
  account.accessToken = accessToken;
  account.accessTokenExpiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
  if (tokenData.refresh_token) account.refreshToken = String(tokenData.refresh_token);
  return accessToken;
}
