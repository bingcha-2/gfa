import * as dotenv from "dotenv";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import { chromium } from "playwright";
import { triggerMagicLinkViaBrowser } from "../apps/api/src/rosetta/lib/playwright-oauth";
import { base64Url, codeChallenge } from "../apps/api/src/rosetta/lib/pkce";
import { ClaudeAccountService } from "../apps/api/src/rosetta/claude-account.service";
import { RosettaContext } from "../apps/api/src/rosetta/lib/context";
import { defaultRemoteAccessDataDir } from "../apps/api/src/remote-access/data-dir";
import { proxyRequiredFetch } from "../apps/api/src/lease-core/egress";
import { toSocks5ProxyUrl } from "../apps/api/src/rosetta/lib/store";

// Load environment variables
dotenv.config({ path: path.join(__dirname, "../.env") });

async function runTest() {
  const profileId = "k1bvbavq";
  const email = "aaliyahfloy849@gmail.com";
  const password = "KX6DtN8DIE7pvS2";
  const recoveryEmail = "aaliyahfloy8495671@hotmail.com";
  const totpSecret = "nxuzam2vavbgluia36j3k4xpfuj3oamx";

  const proxyUrl = "socks5://qhBGDgOnpaVu:fh6i2WcMJO@206.40.215.53:443";

  console.log(`[test-gmail] Starting Gmail OAuth import test...`);
  console.log(`[test-gmail] Profile: ${profileId}`);
  console.log(`[test-gmail] Email: ${email}`);
  console.log(`[test-gmail] Recovery: ${recoveryEmail}`);
  console.log(`[test-gmail] TOTP Secret: ${totpSecret}`);
  console.log(`[test-gmail] Proxy: ${proxyUrl}`);

  // Generate OAuth authorize URL matching backend
  const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  const CLAUDE_OAUTH_AUTH_ENDPOINT = "https://claude.com/cai/oauth/authorize";
  const CLAUDE_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
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

  // Initialize ClaudeAccountService context
  const dataDir = defaultRemoteAccessDataDir();
  const ctx = { dataDir } as RosettaContext;
  const mockAccessKeyService = {
    boundCardCounts: () => new Map(),
    boundSharesByAccount: () => new Map(),
    clearBindingsForAccount: () => {}
  } as any;
  const claudeSvc = new ClaudeAccountService(ctx, mockAccessKeyService);

  console.log("[test-gmail] Phase 1: Launching browser and entering email on Claude authorize page...");
  const triggerStart = Date.now();
  const triggerResult = await triggerMagicLinkViaBrowser({
    authorizeUrl,
    email,
    password,
    proxyUrl,
    adspowerProfileId: profileId,
    recoveryEmail,
    totpSecret,
  });

  if (!triggerResult.ok || !triggerResult.session) {
    throw new Error(`Browser trigger failed: ${triggerResult.error}`);
  }

  console.log("[test-gmail] Phase 1 Succeeded! AdsPower browser launched and email submitted.");

  try {
    const domain = email.split("@")[1]?.toLowerCase() || "";
    const isGmail = domain === "gmail.com";

    let mailResultUrl = "";
    if (!isGmail) {
      console.log("[test-gmail] Phase 2: Polling inbox via IMAP for the magic link...");
      const sinceMs = triggerStart - 30000;
      
      const mailResult = await claudeSvc.fetchClaudeMagicLink({
        email,
        password,
        sinceMs,
        waitMs: 90000,
        maxWaitMs: 90000,
        proxyUrl,
      });

      if (!mailResult.ok || !mailResult.url) {
        throw new Error(`Failed to fetch magic link: ${mailResult.error}`);
      }
      mailResultUrl = mailResult.url;
      console.log(`[test-gmail] Phase 2 Succeeded! Magic link found: ${mailResultUrl}`);
    } else {
      console.log("[test-gmail] Phase 2: Gmail account logged in directly, bypassing magic link fetch.");
    }

    console.log("[test-gmail] Phase 3: Consuming magic link in browser...");
    const consume = await triggerResult.session.consumeMagicLink(mailResultUrl, 60000);

    if (!consume.ok || !consume.code) {
      throw new Error(`Failed to consume magic link: ${consume.error}`);
    }

    console.log(`[test-gmail] Phase 3 Succeeded! Got OAuth code: ${consume.code}`);
    console.log(`[test-gmail] Authorization flow successfully completed up to callback!`);

    console.log("[test-gmail] Phase 4: Exchanging OAuth code for tokens...");
    const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
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

    console.log(`[test-gmail] Phase 4 Succeeded! Email from token: ${gotEmail}`);
    console.log(`[test-gmail] Refresh Token: ${refreshToken.slice(0, 15)}...`);
    console.log(`[test-gmail] Access Token: ${accessToken.slice(0, 15)}...`);

    console.log("[test-gmail] Phase 5: Saving account to database...");
    const filePath = path.join(dataDir, "anthropic-accounts.json");
    let fileData = { accounts: [] as any[], updatedAt: "" };
    if (fs.existsSync(filePath)) {
      fileData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    const accounts = Array.isArray(fileData.accounts) ? fileData.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());

    if (existing) {
      existing.refreshToken = refreshToken;
      existing.accessToken = accessToken;
      existing.accessTokenExpiresAt = expiresAt;
      existing.proxyUrl = proxyUrl;
      existing.mailPassword = password;
      existing.recoveryEmail = recoveryEmail;
      existing.totpSecret = totpSecret;
      existing.adspowerProfileId = profileId;
      existing.alias = String(tokenData?.organization?.name || existing.alias || "");
      console.log(`[test-gmail] Updated existing account ID: ${existing.id}`);
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
        mailPassword: password,
        recoveryEmail,
        totpSecret,
        adspowerProfileId: profileId,
      });
      console.log(`[test-gmail] Created new account ID: ${newId}`);
    }

    fileData.accounts = accounts;
    fileData.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), "utf8");
    console.log("[test-gmail] Account saved successfully to anthropic-accounts.json!");

  } finally {
    console.log("[test-gmail] Cleaning up browser context...");
    await triggerResult.session.close().catch(console.error);
    console.log("[test-gmail] Done.");
  }
}

runTest().catch((err) => {
  console.error("❌ TEST FAILED:", err);
});
