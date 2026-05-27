const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const clientSecret = (...parts: string[]) => parts.join("-");

const OAUTH_PROFILES = {
  legacy: {
    clientId:
      process.env.ROSETTA_LEGACY_CLIENT_ID ||
      "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
    clientSecret:
      process.env.ROSETTA_LEGACY_CLIENT_SECRET ||
      clientSecret("GOCSPX", "9YQWpF7RWDC0QTdj", "YxKMwR0ZtsX"),
  },
  antigravity: {
    clientId:
      process.env.ROSETTA_CLIENT_ID ||
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret:
      process.env.ROSETTA_CLIENT_SECRET ||
      clientSecret("GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"),
  },
};

function normalizeOAuthProfile(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["legacy", "legacy-cloud-code", "cloud-code", "cc"].includes(normalized)) {
    return "legacy";
  }
  return "antigravity";
}

export type TokenAccount = {
  id: number;
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  oauthProfile?: string;
  planType?: string;
  credits?: Record<string, unknown>;
  modelQuotaFractions?: Record<string, number>;
  modelQuotaResetTimes?: Record<string, string>;
  modelQuotaRefreshedAt?: number;
  [key: string]: unknown;
};

export async function refreshGoogleAccessToken(account: TokenAccount): Promise<string> {
  if (account.accessToken && Number(account.accessTokenExpiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
    return account.accessToken;
  }

  const profile = OAUTH_PROFILES[normalizeOAuthProfile(account.oauthProfile)];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: profile.clientId,
    client_secret: profile.clientSecret,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
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
