import * as dotenv from "dotenv";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";

// Load environment variables from .env
dotenv.config({ path: path.join(__dirname, "../.env") });

// Force the new AdsPower API Key to run tests
process.env.ADSPOWER_API_KEY = "72b3bff4dfd7dafca46046dd4c5c1992008379d6ce494bed";

import { triggerMagicLinkViaBrowser } from "../apps/api/src/rosetta/lib/playwright-oauth";
import { fetchAnthropicMagicLinkViaWeb } from "../apps/api/src/rosetta/lib/mailcom-web-magic-link";
import { base64Url, codeChallenge } from "../apps/api/src/rosetta/lib/pkce";
import { proxyRequiredFetch } from "../apps/api/src/lease-core/egress";
import { defaultRemoteAccessDataDir } from "../apps/api/src/remote-access/data-dir";
import { toSocks5ProxyUrl } from "../apps/api/src/rosetta/lib/store";

async function runTest() {
  const profileId = "k1bvbavq"; // 固定浏览器 k1bvbavq
  const email = "NaylorAshleyddb@programmer.net";
  const mailPassword = "Okj5nWGj6d92";
  const rawProxy = "qhBGDgOnpaVu:fh6i2WcMJO@206.40.215.53:443";
  const proxyUrl = toSocks5ProxyUrl(rawProxy);

  console.log(`[test-full] Profile ID: ${profileId}`);
  console.log(`[test-full] Email: ${email}`);
  console.log(`[test-full] Proxy URL: ${proxyUrl}`);

  // Generate PKCE authorize URL matching backend exactly
  const CLAUDE_OAUTH_CLIENT_ID = process.env.BCAI_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  const CLAUDE_OAUTH_AUTH_ENDPOINT = process.env.BCAI_CLAUDE_AUTHORIZE_URL || "https://claude.com/cai/oauth/authorize";
  const CLAUDE_OAUTH_REDIRECT_URI = process.env.BCAI_CLAUDE_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback";
  const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

  const codeVerifier = base64Url(crypto.randomBytes(32));
  const state = base64Url(crypto.randomBytes(32));
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    scope: CLAUDE_OAUTH_SCOPES,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
  });
  const authorizeUrl = `${CLAUDE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`;

  console.log(`[test-full] Generated Auth URL: ${authorizeUrl}`);

  console.log("[test-full] Phase 1: Triggering magic link via AdsPower browser...");
  const triggerStart = Date.now();
  const triggerResult = await triggerMagicLinkViaBrowser({
    authorizeUrl,
    email,
    proxyUrl,
    adspowerProfileId: profileId,
  });

  if (!triggerResult.ok || !triggerResult.session) {
    throw new Error(`Browser trigger failed: ${triggerResult.error}`);
  }

  console.log("[test-full] Phase 1 succeeded! AdsPower session created.");

  try {
    console.log("[test-full] Phase 2: Polling mail.com for the login magic link...");
    const sinceMs = Date.now() - 5000;
    console.log(`[test-full] Filtering emails since: ${new Date(sinceMs).toISOString()} (sinceMs: ${sinceMs})`);
    const mailResult = await fetchAnthropicMagicLinkViaWeb({
      email,
      password: mailPassword,
      sinceMs,
      waitMs: 90_000,
    });

    if (!mailResult.ok || !mailResult.url) {
      throw new Error(`Failed to fetch magic link: ${mailResult.error}`);
    }

    console.log(`[test-full] Phase 2 succeeded!`);
    console.log(`[test-full] - Subject: ${mailResult.subject}`);
    console.log(`[test-full] - Date: ${mailResult.date}`);
    console.log(`[test-full] - URL: ${mailResult.url}`);

    console.log("[test-full] Phase 3: Consuming magic link in browser...");
    let consume;
    try {
      consume = await triggerResult.session.consumeMagicLink(mailResult.url, 60_000);
    } catch (err) {
      console.error("[test-full] Error during consumeMagicLink, taking screenshot...");
      const screenshotPath = path.join(__dirname, "../screenshot_consume_error.png");
      await triggerResult.session.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.log(`[test-full] Screenshot saved to ${screenshotPath}`);
      throw err;
    }

    if (!consume.ok || !consume.code) {
      console.error(`[test-full] Consume failed: ${consume.error}, taking screenshot...`);
      const screenshotPath = path.join(__dirname, "../screenshot_consume_failed.png");
      await triggerResult.session.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.log(`[test-full] Screenshot saved to ${screenshotPath}`);
      throw new Error(`Failed to consume magic link: ${consume.error}`);
    }

    console.log(`[test-full] Phase 3 succeeded! Got OAuth code: ${consume.code}, state: ${consume.state}`);

    console.log("[test-full] Phase 4: Exchanging OAuth code for tokens...");
    const CLAUDE_OAUTH_TOKEN_ENDPOINT = process.env.BCAI_CLAUDE_TOKEN_ENDPOINT || "https://platform.claude.com/v1/oauth/token";
    const response = await proxyRequiredFetch(proxyUrl, CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: consume.code,
        state: consume.state || state,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    const tokenData = JSON.parse(text);
    const gotEmail = String(tokenData?.account?.email_address || tokenData?.account?.email || "").trim();
    const refreshToken = String(tokenData.refresh_token || "");
    const accessToken = String(tokenData.access_token || "");
    const expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;

    console.log(`[test-full] Phase 4 succeeded! Email from token: ${gotEmail}`);
    console.log(`[test-full] Refresh Token: ${refreshToken.slice(0, 15)}...`);
    console.log(`[test-full] Access Token: ${accessToken.slice(0, 15)}...`);

    console.log("[test-full] Phase 5: Saving account info to anthropic-accounts.json...");
    const dataDir = defaultRemoteAccessDataDir();
    const filePath = path.join(dataDir, "anthropic-accounts.json");
    console.log(`[test-full] Data directory: ${dataDir}`);

    let data = { accounts: [] as any[], updatedAt: "" };
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());

    if (existing) {
      existing.refreshToken = refreshToken;
      existing.accessToken = accessToken;
      existing.accessTokenExpiresAt = expiresAt;
      existing.proxyUrl = proxyUrl;
      existing.mailPassword = mailPassword;
      existing.adspowerProfileId = profileId;
      existing.alias = String(tokenData?.organization?.name || existing.alias || "");
      console.log(`[test-full] Updated existing account ID: ${existing.id}`);
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      const newId = maxId + 1;
      accounts.push({
        id: newId,
        email: gotEmail || email,
        refreshToken,
        accessToken,
        accessTokenExpiresAt: expiresAt,
        enabled: true,
        alias: String(tokenData?.organization?.name || ""),
        planType: "pro",
        proxyUrl,
        mailPassword,
        adspowerProfileId: profileId,
      });
      console.log(`[test-full] Created new account ID: ${newId}`);
    }

    data.accounts = accounts;
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    console.log("[test-full] File written successfully.");
    console.log("=========================================");
    console.log("✅ FULL FLOW OAUTH TEST COMPLETED SUCCESSFULLY!");
    console.log("=========================================");

  } finally {
    console.log("[test-full] Cleaning up browser session...");
    await triggerResult.session.close().catch(console.error);
    console.log("[test-full] Cleanup done.");
  }
}

runTest().catch((err) => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
