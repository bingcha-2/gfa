import * as dotenv from "dotenv";
import * as path from "path";
import * as crypto from "crypto";

// Load environment variables from .env
dotenv.config({ path: path.join(__dirname, "../.env") });

import { triggerMagicLinkViaBrowser } from "../apps/api/src/rosetta/lib/playwright-oauth";
import { base64Url, codeChallenge } from "../apps/api/src/rosetta/lib/pkce";

// Helper to normalize the user's proxy input
function parseUserProxy(raw: string): string {
  // format: 173.44.178.29:443:jwuSpcQhYhCA:MmWs749bsE
  const parts = raw.split(":");
  if (parts.length === 4) {
    const [ip, port, user, pass] = parts;
    return `socks5://${user}:${pass}@${ip}:${port}`;
  }
  return raw;
}

async function runTest() {
  const profileId = "k1df102e";
  const email = "pivrcarolinema3lcx@reincarnate.com";
  const rawProxy = "173.44.178.29:443:jwuSpcQhYhCA:MmWs749bsE";
  const proxyUrl = parseUserProxy(rawProxy);

  console.log(`[test] Profile ID: ${profileId}`);
  console.log(`[test] Email: ${email}`);
  console.log(`[test] Proxy: ${proxyUrl}`);

  // Generate PKCE authorize URL
  const CLAUDE_OAUTH_CLIENT_ID = process.env.BCAI_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  const CLAUDE_OAUTH_AUTH_ENDPOINT = process.env.BCAI_CLAUDE_AUTHORIZE_URL || "https://claude.com/cai/oauth/authorize";
  const CLAUDE_OAUTH_REDIRECT_URI = process.env.BCAI_CLAUDE_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback";
  const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = codeChallenge(verifier);
  const state = base64Url(crypto.randomBytes(16));
  const authorizeUrl = `${CLAUDE_OAUTH_AUTH_ENDPOINT}?response_type=code&client_id=${CLAUDE_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(CLAUDE_OAUTH_REDIRECT_URI)}&scope=${encodeURIComponent(CLAUDE_OAUTH_SCOPES)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  console.log(`[test] Auth URL: ${authorizeUrl}`);

  const triggerResult = await triggerMagicLinkViaBrowser({
    authorizeUrl,
    email,
    proxyUrl,
    adspowerProfileId: profileId,
  });

  if (triggerResult.ok && triggerResult.session) {
    console.log("[test] Trigger succeeded! Session obtained.");
    console.log("[test] Keeping browser open for 15s to let you inspect, then closing...");
    await new Promise((resolve) => setTimeout(resolve, 15000));
    await triggerResult.session.close();
    console.log("[test] Session closed successfully.");
  } else {
    console.error(`[test] Trigger failed: ${triggerResult.error}`);
  }
}

runTest().catch(console.error);
