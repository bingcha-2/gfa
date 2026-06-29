import * as fs from "fs";
import * as path from "path";

import { chromium } from "playwright";

import { CodexService } from "../apps/server/src/leasing/rosetta/codex.service";
import { AdsPowerClient } from "../apps/server/src/leasing/rosetta/lib/adspower-client";
import { defaultDataDir, readJson } from "../apps/server/src/leasing/rosetta/lib/store";
import { parseProxyToAdsPowerUserConfig } from "../apps/server/src/leasing/rosetta/lib/adspower-profile-manager";

type ScriptOptions = {
  email: string;
  dataDir: string;
  password?: string;
  passwordEnv: string;
  adspowerProfileId?: string;
  proxyUrl?: string;
  totpSecret?: string;
  phoneNumber?: string;
  smsUrl?: string;
  smokeOnly: boolean;
  smokeTimeoutMs: number;
  pollMs: number;
};

type CodexAccountRecord = {
  id?: number;
  email?: string;
  enabled?: boolean;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  planType?: string;
  proxyUrl?: string;
  adspowerProfileId?: string;
  adspowerProfileStatus?: string;
  adspowerProfileProvider?: string;
  adspowerProfileLastUsedAt?: string;
  updatedAt?: string;
};

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm exec tsx scripts/retry-codex-auto-login.ts --email <hotmail> [options]",
      "",
      "Options:",
      "  --data-dir <path>           Rosetta data dir (default: D:/GFA-data/rosetta if present, else defaultDataDir())",
      "  --password-env <NAME>       Read mailbox password from env var (default: CODEX_ACCOUNT_PASSWORD)",
      "  --password <value>          Mailbox password, for one-off local runs only",
      "  --profile-id <id>           Override AdsPower profile id",
      "  --proxy-url <url>           Override proxy url",
      "  --totp-secret <secret>      Optional Google TOTP secret",
      "  --phone-number <digits>     Optional phone number for add-phone flow",
      "  --sms-url <url>             Optional SMS polling url",
      "  --smoke-only                Only test whether the OpenAI login surface becomes interactive",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): ScriptOptions {
  const defaultsDir = fs.existsSync("D:/GFA-data/rosetta") ? "D:/GFA-data/rosetta" : defaultDataDir();
  const opts: ScriptOptions = {
    email: "",
    dataDir: defaultsDir,
    passwordEnv: "CODEX_ACCOUNT_PASSWORD",
    smokeOnly: false,
    smokeTimeoutMs: 45_000,
    pollMs: 1_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--email" && next) {
      opts.email = next.trim();
      i++;
      continue;
    }
    if (arg === "--data-dir" && next) {
      opts.dataDir = next.trim();
      i++;
      continue;
    }
    if (arg === "--password-env" && next) {
      opts.passwordEnv = next.trim();
      i++;
      continue;
    }
    if (arg === "--password" && next) {
      opts.password = next;
      i++;
      continue;
    }
    if (arg === "--profile-id" && next) {
      opts.adspowerProfileId = next.trim();
      i++;
      continue;
    }
    if (arg === "--proxy-url" && next) {
      opts.proxyUrl = next.trim();
      i++;
      continue;
    }
    if (arg === "--totp-secret" && next) {
      opts.totpSecret = next.trim();
      i++;
      continue;
    }
    if (arg === "--phone-number" && next) {
      opts.phoneNumber = next.replace(/\D/g, "");
      i++;
      continue;
    }
    if (arg === "--sms-url" && next) {
      opts.smsUrl = next.trim();
      i++;
      continue;
    }
    if (arg === "--smoke-only") {
      opts.smokeOnly = true;
      continue;
    }
    usage();
  }
  if (!opts.email) usage();
  return opts;
}

function hydrateEnvFromDotEnv(dotEnvPath: string) {
  if (!fs.existsSync(dotEnvPath)) return;
  for (const rawLine of fs.readFileSync(dotEnvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (process.env[key]) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function maskProxy(proxyUrl?: string): string {
  if (!proxyUrl) return "";
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//***@${parsed.hostname}:${parsed.port}`;
  } catch {
    return "<configured>";
  }
}

function summarizeAccount(account: CodexAccountRecord | undefined) {
  if (!account) return null;
  return {
    id: Number(account.id || 0),
    email: String(account.email || ""),
    enabled: account.enabled !== false,
    hasRefreshToken: Boolean(account.refreshToken),
    hasAccessToken: Boolean(account.accessToken),
    accessTokenExpiresAt: Number(account.accessTokenExpiresAt || 0) || null,
    planType: String(account.planType || ""),
    proxyUrl: maskProxy(account.proxyUrl),
    adspowerProfileId: String(account.adspowerProfileId || ""),
    adspowerProfileStatus: String(account.adspowerProfileStatus || ""),
    adspowerProfileProvider: String(account.adspowerProfileProvider || ""),
    adspowerProfileLastUsedAt: String(account.adspowerProfileLastUsedAt || ""),
  };
}

function loadCodexAccount(dataDir: string, email: string): CodexAccountRecord | undefined {
  const filePath = path.join(dataDir, "codex-accounts.json");
  const data = readJson(filePath, { accounts: [] });
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  return accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
}

function logSection(title: string, payload: unknown) {
  console.log(`\n=== ${title} ===`);
  if (payload !== undefined) {
    console.log(JSON.stringify(payload, null, 2));
  }
}

async function smokeProfileToOpenAiLoginSurface(profileId: string, proxyUrl: string | undefined, timeoutMs: number) {
  const client = new AdsPowerClient({
    baseUrl: process.env.ADSPOWER_HOST || "http://127.0.0.1:50325",
    apiKey: process.env.ADSPOWER_API_KEY || "",
  });
  const proxyConfig = proxyUrl ? parseProxyToAdsPowerUserConfig(proxyUrl) : undefined;
  const opened = await client.openProfile(profileId, proxyConfig);
  const browser = await chromium.connectOverCDP(opened.debugUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error(`AdsPower profile ${profileId} did not expose a browser context`);
    const page = context.pages().find((item) => /auth\.openai\.com/i.test(item.url())) || (await context.newPage());
    await page.goto("https://auth.openai.com/log-in", { waitUntil: "domcontentloaded", timeout: 40_000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let lastState = "";
    while (Date.now() < deadline) {
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
      const title = await page.title().catch(() => "");
      const url = page.url();
      const text = await page.locator("body").innerText({ timeout: 1_500 }).catch(() => "");
      const emailCount = await page
        .locator('input[type="email"], input[name="email"], input[autocomplete="username"]')
        .count()
        .catch(() => 0);
      const state =
        emailCount > 0
          ? "login-form"
          : /performing security verification|protect against malicious bots|just a moment/i.test(`${title} ${text}`)
            ? "security-verification"
            : `waiting:${url}`;
      if (state !== lastState) {
        console.log(`[smoke] ${state} | title="${title}" | url=${url}`);
        lastState = state;
      }
      if (emailCount > 0) {
        return { ok: true as const, title, url };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { ok: false as const, error: `OpenAI login form did not become interactive within ${Math.round(timeoutMs / 1000)}s` };
  } finally {
    await browser.close().catch(() => {});
    await client.closeProfile(profileId).catch(() => {});
  }
}

async function runAutoLogin(opts: ScriptOptions, account: CodexAccountRecord | undefined) {
  const password = opts.password || process.env[opts.passwordEnv] || "";
  if (!password) {
    console.log(
      `[login] skipped actual re-entry because ${opts.passwordEnv} is not set. ` +
        `Smoke check already verified whether the login page becomes interactive.`,
    );
    return null;
  }
  const stubAccessKey = {
    boundCardCounts: () => new Map<number, number>(),
    boundSharesByAccount: () => new Map<number, number>(),
  } as any;
  const service = new CodexService(
    { dataDir: opts.dataDir, codexOAuthPort: 1455, codexOAuthFetch: fetch } as any,
    stubAccessKey,
  );
  const startResult = service.startAutomatedCodexLogin({
    email: opts.email,
    password,
    totpSecret: opts.totpSecret || "",
    phoneNumber: opts.phoneNumber || "",
    smsUrl: opts.smsUrl || "",
    proxyUrl: opts.proxyUrl || account?.proxyUrl || "",
    adspowerProfileId: opts.adspowerProfileId || account?.adspowerProfileId || "",
  });
  logSection("Auto Login Start", startResult);
  if (!startResult?.ok || !startResult.jobId) {
    throw new Error(`Unable to start codex auto login: ${JSON.stringify(startResult)}`);
  }
  let lastStep = "";
  while (true) {
    const status = service.getAutomatedCodexLoginStatus(startResult.jobId);
    if (!status?.ok) {
      throw new Error(`Auto login status missing: ${JSON.stringify(status)}`);
    }
    if (status.step !== lastStep) {
      console.log(`[login] status=${status.status} step=${status.step} error=${status.error || ""}`);
      lastStep = status.step;
    }
    if (status.status === "completed" || status.status === "failed") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

async function main() {
  hydrateEnvFromDotEnv(path.join(process.cwd(), ".env"));
  const opts = parseArgs(process.argv.slice(2));
  const account = loadCodexAccount(opts.dataDir, opts.email);
  const resolvedProfileId = opts.adspowerProfileId || account?.adspowerProfileId || "";
  const resolvedProxyUrl = opts.proxyUrl || account?.proxyUrl || "";

  logSection("Before", summarizeAccount(account));

  if (!resolvedProfileId) {
    throw new Error(`No AdsPower profile id found for ${opts.email}. Pass --profile-id or bind one first.`);
  }

  const smoke = await smokeProfileToOpenAiLoginSurface(resolvedProfileId, resolvedProxyUrl, opts.smokeTimeoutMs);
  logSection("Smoke Result", smoke);
  if (!smoke.ok) {
    process.exitCode = 1;
    return;
  }

  if (opts.smokeOnly) return;

  const status = await runAutoLogin(opts, account);
  if (!status) return;
  logSection("Auto Login Result", status);
  logSection("After", summarizeAccount(loadCodexAccount(opts.dataDir, opts.email)));
  if (status.status !== "completed") {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
