// Fully automated Claude OAuth via headless Chromium + SOCKS5 proxy.
//
// Chromium does NOT support authenticated SOCKS5 proxies (username:password).
// Workaround: spin up a local no-auth SOCKS5 relay on 127.0.0.1 that forwards
// every connection through the remote authenticated SOCKS5 proxy using the
// `socks` package. Chromium connects to the local relay — no auth needed.
//
// Flow:
//   1. Start local SOCKS5 relay → remote authenticated SOCKS5
//   2. Launch Chromium with --proxy-server=socks5://127.0.0.1:<localPort>
//   3. Navigate to authorize URL → CF challenge executes → login page loads
//   4. Fill email, click submit → magic link sent
//   5. (Caller fetches magic link from mail.com inbox)
//   6. Browser navigates to magic link → SPA → OAuth consent → callback ?code=
//   7. Return code; caller exchanges for tokens

import * as net from "net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SocksClient } from "socks";
import * as OTPAuth from "otpauth";
import { AdsPowerClient } from "./adspower-client";

export type PlaywrightOAuthOpts = {
  authorizeUrl: string;
  email: string;
  password?: string;
  recoveryEmail?: string;
  totpSecret?: string;
  proxyUrl?: string; // socks5://user:pass@host:port
  adspowerProfileId?: string;
};

export function generateGoogleTOTP(secret: string): string {
  const cleaned = secret.replace(/[\s\-=]/g, "").toUpperCase();
  const totp = new OTPAuth.TOTP({
    issuer: "Google",
    label: "Account",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(cleaned),
  });
  return totp.generate();
}

export type TriggerResult = {
  ok: boolean;
  error?: string;
  session?: PlaywrightOAuthSession;
};

export type ConsumeResult = {
  ok: boolean;
  code?: string;
  state?: string;
  callbackUrl?: string;
  error?: string;
};

// ── Local SOCKS5 relay (no-auth → authenticated upstream) ────────────────

type RelayHandle = { port: number; close: () => void };

export function startLocalSocksRelay(upstream: { host: string; port: number; userId?: string; password?: string }): Promise<RelayHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      handleSocks5Client(client, upstream).catch(() => client.destroy());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => { try { server.close(); } catch {} },
      });
    });
  });
}

// Minimal SOCKS5 server: accept NO-AUTH greeting + CONNECT command from
// Chromium, then open the real connection through the authenticated upstream.
async function handleSocks5Client(
  client: net.Socket,
  upstream: { host: string; port: number; userId?: string; password?: string },
) {
  const read = (_n: number): Promise<Buffer> =>
    new Promise((res, rej) => {
      const onData = (chunk: Buffer) => { client.off("error", rej); res(chunk); };
      client.once("data", onData);
      client.once("error", rej);
    });

  // 1. Greeting: client sends [0x05, nMethods, ...methods]
  const greeting = await read(3);
  if (greeting[0] !== 0x05) { client.destroy(); return; }
  // Reply: no auth required
  client.write(Buffer.from([0x05, 0x00]));

  // 2. CONNECT request: [0x05, 0x01, 0x00, addrType, ...addr, port(2)]
  const req = await read(512);
  if (req[0] !== 0x05 || req[1] !== 0x01) { client.destroy(); return; }
  const addrType = req[3];
  let destHost: string;
  let destPort: number;
  let offset: number;

  if (addrType === 0x01) {
    // IPv4
    destHost = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
    offset = 8;
  } else if (addrType === 0x03) {
    // Domain
    const len = req[4];
    destHost = req.subarray(5, 5 + len).toString("ascii");
    offset = 5 + len;
  } else if (addrType === 0x04) {
    // IPv6
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(req.readUInt16BE(4 + i).toString(16));
    destHost = parts.join(":");
    offset = 20;
  } else {
    client.destroy();
    return;
  }
  destPort = req.readUInt16BE(offset);

  // 3. Connect through upstream authenticated SOCKS5
  try {
    const { socket: remote } = await SocksClient.createConnection({
      proxy: {
        host: upstream.host,
        port: upstream.port,
        type: 5,
        userId: upstream.userId,
        password: upstream.password,
      },
      command: "connect",
      destination: { host: destHost, port: destPort },
      timeout: 30_000,
    });

    // Success reply
    const reply = Buffer.alloc(10);
    reply[0] = 0x05; // ver
    reply[1] = 0x00; // success
    reply[2] = 0x00; // reserved
    reply[3] = 0x01; // IPv4
    // BND.ADDR + BND.PORT = zeros (Chromium ignores these)
    client.write(reply);

    // Pipe bidirectionally
    client.pipe(remote);
    remote.pipe(client);
    client.on("error", () => remote.destroy());
    remote.on("error", () => client.destroy());
    client.on("close", () => remote.destroy());
    remote.on("close", () => client.destroy());
  } catch {
    // Connection failed reply
    const fail = Buffer.alloc(10);
    fail[0] = 0x05;
    fail[1] = 0x05; // connection refused
    fail[3] = 0x01;
    client.write(fail);
    client.destroy();
  }
}

// ── Playwright OAuth session ─────────────────────────────────────────────

export class PlaywrightOAuthSession {
  constructor(
    private browser: Browser,
    private context: BrowserContext,
    public page: Page,
    private relay?: RelayHandle,
    private adspowerOpts?: { client: AdsPowerClient; profileId: string },
  ) {}

  async consumeMagicLink(magicLinkUrl: string, timeoutMs = 60_000): Promise<ConsumeResult> {
    try {
      const callbackPattern = /\/oauth\/code\/callback\?/;

      const codePromise = new Promise<{ code: string; state: string; url: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 OAuth 回调超时")), timeoutMs);

        const check = (url: string) => {
          if (!callbackPattern.test(url)) return;
          clearTimeout(timer);
          try {
            const parsed = new URL(url);
            resolve({
              code: parsed.searchParams.get("code") || "",
              state: parsed.searchParams.get("state") || "",
              url,
            });
          } catch {
            reject(new Error(`回调 URL 解析失败: ${url}`));
          }
        };

        this.page.on("request", (req) => check(req.url()));
        this.page.on("framenavigated", (frame) => {
          if (frame === this.page.mainFrame()) check(frame.url());
        });
      });

      if (magicLinkUrl) {
        await this.page.goto(magicLinkUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      }

      // The SPA may show a consent screen
      try {
        const allowBtn = this.page.getByRole("button", { name: /allow|authorize|accept|confirm|continue|同意|授权/i });
        await allowBtn.waitFor({ timeout: 15_000 });
        await allowBtn.click();
      } catch {
        // No consent button — flow might auto-redirect
      }

      const result = await codePromise;
      return {
        ok: Boolean(result.code),
        code: result.code,
        state: result.state,
        callbackUrl: result.url,
        error: result.code ? undefined : "回调中未包含 code",
      };
    } catch (err: any) {
      return { ok: false, error: `消费 magic link 失败: ${err?.message || err}` };
    }
  }

  async close() {
    try { await this.context.close(); } catch {}
    try { await this.browser.close(); } catch {}
    if (this.relay) this.relay.close();
    if (this.adspowerOpts) {
      await this.adspowerOpts.client.closeProfile(this.adspowerOpts.profileId).catch(() => {});
    }
  }
}

// ── Trigger (step 1) ─────────────────────────────────────────────────────

export function parseUpstream(proxyUrl: string) {
  const url = new URL(proxyUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 1080,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

function parseProxyToAdsPowerConfig(proxyUrl: string): any {
  if (!proxyUrl) return null;
  try {
    const url = new URL(proxyUrl);
    const type = url.protocol.replace(":", "");
    if (!["http", "https", "socks5"].includes(type)) {
      return null;
    }
    const config: any = {
      proxy_soft: "other",
      proxy_type: type,
      proxy_host: url.hostname,
      proxy_port: String(url.port || (type === "socks5" ? 1080 : 80)),
    };
    if (url.username) {
      config.proxy_user = decodeURIComponent(url.username);
    }
    if (url.password) {
      config.proxy_password = decodeURIComponent(url.password);
    }
    return config;
  } catch {
    return null;
  }
}

// Anti-automation hardening injected before every page load. Extracted verbatim
// from triggerMagicLinkViaBrowser so the sessionKey-login path runs the exact
// same stealth as the magic-link path (CF challenge passes the same way).
function stealthInit() {
  // 1. Overwrite navigator.webdriver to false
  Object.defineProperty(navigator, "webdriver", { get: () => false });

  // 2. Mock window.chrome
  (window as any).chrome = {
    runtime: {},
    loadTimes: function () {},
    csi: function () {},
    app: {},
  };

  // 3. Mock navigator.plugins
  const pdfViewer = {
    name: "Chrome PDF Viewer",
    filename: "internal-pdf-viewer",
    description: "Portable Document Format",
  };
  Object.defineProperty(navigator, "plugins", {
    get: () => [pdfViewer],
  });

  // 4. Overwrite navigator.permissions.query safely
  const originalQuery = navigator.permissions.query;
  navigator.permissions.query = (parameters: any) => {
    try {
      if (parameters && parameters.name === "notifications") {
        const permission = (window as any).Notification ? (window as any).Notification.permission : "default";
        return Promise.resolve({
          state: permission,
          addEventListener: () => {},
          removeEventListener: () => {},
          onchange: null,
        } as any);
      }
      return originalQuery.call(navigator.permissions, parameters);
    } catch {
      return Promise.resolve({
        state: "default",
        addEventListener: () => {},
        removeEventListener: () => {},
        onchange: null,
      } as any);
    }
  };
}

// ── SessionKey direct login (skip email + magic link) ────────────────────
// Given a claude.ai web session cookie (sk-ant-sid0x-…), inject it as the
// `sessionKey` cookie, navigate the OAuth authorize URL as an already-logged-in
// user, click the consent button if shown, and capture the ?code= callback.
// This is the magic-link flow with the email/inbox steps replaced by a cookie.
//
// EXTERNAL UNKNOWNS (must be confirmed against a live account + proxy):
//   - which domain the sid02 cookie belongs to (.claude.ai vs .claude.com) →
//     we seed BOTH to be safe;
//   - whether CF passes with only a cookie and no human interaction;
//   - whether the consent screen auto-appears / its button copy.
// On failure we return the current page URL to aid debugging.
export async function loginViaSessionKey(opts: {
  authorizeUrl: string;
  sessionKey: string;
  proxyUrl?: string;
  adspowerProfileId?: string;
  timeoutMs?: number;
}): Promise<ConsumeResult> {
  let relay: RelayHandle | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let adspowerOpts: { client: AdsPowerClient; profileId: string } | undefined;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const sk = (opts.sessionKey || "").trim();
  if (!sk) return { ok: false, error: "sessionKey 为空" };

  // Claude's web session cookie is named `sessionKey`; value is the sk-ant-sid0x token.
  const sessionCookie = (domain: string) => ({
    name: "sessionKey",
    value: sk,
    domain,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  });

  try {
    let page: Page;

    if (opts.adspowerProfileId) {
      const host = process.env.ADSPOWER_HOST || "http://127.0.0.1:50325";
      const apiKey = process.env.ADSPOWER_API_KEY || "72b3bff4dfd7dafca46046dd4c5c1992008379d6ce494bed";
      const client = new AdsPowerClient({ baseUrl: host, apiKey });
      const userProxyConfig = opts.proxyUrl ? parseProxyToAdsPowerConfig(opts.proxyUrl) : undefined;
      console.log(`[sk-login] Connecting to AdsPower Profile: ${opts.adspowerProfileId} with proxyUrl: ${opts.proxyUrl || "profile default"}`);

      const openRes = await client.openProfile(opts.adspowerProfileId, userProxyConfig);
      adspowerOpts = { client, profileId: opts.adspowerProfileId };

      browser = await chromium.connectOverCDP(openRes.debugUrl);
      context = browser.contexts()[0];
      if (!context) throw new Error("未在 AdsPower 浏览器实例中找到上下文");

      // Clear any stale cookies BEFORE seeding our sessionKey so we land logged
      // in as exactly this account (the profile may hold another account's cookie).
      await context.clearCookies().catch(() => {});
      page = context.pages()[0] || (await context.newPage());
    } else {
      if (!opts.proxyUrl) throw new Error("未提供 SOCKS5 代理 URL，且未使用指纹浏览器");
      const upstream = parseUpstream(opts.proxyUrl);
      relay = await startLocalSocksRelay(upstream);
      console.log(`[sk-login] local SOCKS5 relay on 127.0.0.1:${relay.port} → ${upstream.host}:${upstream.port}`);

      browser = await chromium.launch({
        headless: false,
        proxy: { server: `socks5://127.0.0.1:${relay.port}` },
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });

      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
      await context.addInitScript(stealthInit);
      page = await context.newPage();
    }

    // Seed the session cookie on both candidate domains before navigating.
    await context.addCookies([sessionCookie(".claude.ai"), sessionCookie(".claude.com")]).catch((e) => {
      console.warn(`[sk-login] addCookies failed: ${e?.message || e}`);
    });

    // Arm the callback listener BEFORE navigating — an already-authorized account
    // can redirect straight to /oauth/code/callback?code= without a consent click.
    const callbackPattern = /\/oauth\/code\/callback\?/;
    const codePromise = new Promise<{ code: string; state: string; url: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 OAuth 回调超时")), timeoutMs);
      const check = (url: string) => {
        if (!callbackPattern.test(url)) return;
        clearTimeout(timer);
        try {
          const parsed = new URL(url);
          resolve({ code: parsed.searchParams.get("code") || "", state: parsed.searchParams.get("state") || "", url });
        } catch {
          reject(new Error(`回调 URL 解析失败: ${url}`));
        }
      };
      page.on("request", (req) => check(req.url()));
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) check(frame.url());
      });
    });

    console.log("[sk-login] navigating to authorize URL with injected sessionKey...");
    await page.goto(opts.authorizeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
      // A mid-navigation redirect to the callback can abort goto — that's fine,
      // the listener still fires. Only surface non-redirect failures.
      console.log(`[sk-login] goto note: ${e?.message || e}`);
    });

    // The consent screen may need an explicit Authorize/Allow click.
    try {
      const allowBtn = page.getByRole("button", { name: /allow|authorize|accept|confirm|continue|同意|授权/i });
      await allowBtn.waitFor({ timeout: 15_000 });
      await allowBtn.click();
      console.log("[sk-login] clicked consent/authorize button");
    } catch {
      // No consent button — either auto-redirect or not logged in (sessionKey bad).
    }

    const result = await codePromise;
    return {
      ok: Boolean(result.code),
      code: result.code,
      state: result.state,
      callbackUrl: result.url,
      error: result.code ? undefined : "回调中未包含 code",
    };
  } catch (err: any) {
    let snapshot = "";
    try {
      const pgs = context?.pages() || [];
      if (pgs[0]) {
        const url = pgs[0].url();
        const body = await pgs[0].textContent("body").catch(() => "");
        snapshot = ` (url=${url}, page=${(body || "").slice(0, 200)})`;
      }
    } catch {}
    return { ok: false, error: `SK 直登失败: ${err?.message || err}${snapshot}` };
  } finally {
    try { if (context && !opts.adspowerProfileId) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    if (relay) relay.close();
    if (adspowerOpts) await adspowerOpts.client.closeProfile(adspowerOpts.profileId).catch(() => {});
  }
}

export async function triggerMagicLinkViaBrowser(opts: PlaywrightOAuthOpts): Promise<TriggerResult> {
  let relay: RelayHandle | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let adspowerOpts: { client: AdsPowerClient; profileId: string } | undefined;

  try {
    let page: Page;

    if (opts.adspowerProfileId) {
      const host = process.env.ADSPOWER_HOST || "http://127.0.0.1:50325";
      const apiKey = process.env.ADSPOWER_API_KEY || "72b3bff4dfd7dafca46046dd4c5c1992008379d6ce494bed";
      const client = new AdsPowerClient({ baseUrl: host, apiKey });

      const userProxyConfig = opts.proxyUrl ? parseProxyToAdsPowerConfig(opts.proxyUrl) : undefined;
      console.log(`[playwright-oauth] Connecting to AdsPower Profile: ${opts.adspowerProfileId} with proxyUrl: ${opts.proxyUrl || "profile default"}`);

      const openRes = await client.openProfile(opts.adspowerProfileId, userProxyConfig);
      adspowerOpts = { client, profileId: opts.adspowerProfileId };

      browser = await chromium.connectOverCDP(openRes.debugUrl);
      context = browser.contexts()[0];
      if (!context) {
        throw new Error("未在 AdsPower 浏览器实例中找到上下文");
      }

      await context.clearCookies().catch(() => {});
      page = context.pages()[0] || await context.newPage();
    } else {
      if (!opts.proxyUrl) {
        throw new Error("未提供 SOCKS5 代理 URL，且未使用指纹浏览器");
      }
      const upstream = parseUpstream(opts.proxyUrl);
      relay = await startLocalSocksRelay(upstream);
      console.log(`[playwright-oauth] local SOCKS5 relay on 127.0.0.1:${relay.port} → ${upstream.host}:${upstream.port}`);

      browser = await chromium.launch({
        headless: false,
        proxy: { server: `socks5://127.0.0.1:${relay.port}` },
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
        ],
      });

      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });

      await context.addInitScript(stealthInit);

      page = await context.newPage();
    }

    console.log("[playwright-oauth] navigating to authorize URL...");
    await page.goto(opts.authorizeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const isGmail = opts.email.toLowerCase().endsWith("@gmail.com");

    if (isGmail) {
      console.log("[playwright-oauth] Gmail account detected. Using Google Sign-in flow...");
      
      // Listen for popup page
      const popupPromise = page.context().waitForEvent("page");

      // 1. Click "Continue with Google" button
      const googleBtn = page.locator('button:has-text("Continue with Google"), button:has-text("Google")').first();
      await googleBtn.waitFor({ state: "visible", timeout: 15_000 });
      await googleBtn.click();
      console.log("[playwright-oauth] Clicked Continue with Google. Waiting for Google / Claude redirect...");
      
      // Wait to see if a popup is opened
      let targetPage = page;
      try {
        const popup = await Promise.race([
          popupPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 5000))
        ]);
        if (popup) {
          console.log("[playwright-oauth] Google sign-in opened in a popup window.");
          targetPage = popup;
        }
      } catch (e) {
        // Fall back to main page if popup wait fails
      }

      // 2. Wait for Google Account pages or Claude authorization redirect
      const deadline = Date.now() + 300_000;
      let loggedIn = false;
      let accountCardClicked = false;
      let emailSubmitted = false;
      let passwordSubmitted = false;
      let challengeSelectionClicked = false;
      let lastTotpSubmitTime = 0;
      let lastRecoverySubmitTime = 0;
      let lastConsentSubmitTime = 0;
      
      while (Date.now() < deadline) {
        if (page.isClosed()) {
          console.log("[playwright-oauth] Main page closed. Exiting loop.");
          break;
        }

        let mainUrl = "";
        try {
          mainUrl = page.url();
        } catch (e) {
          console.log("[playwright-oauth] Failed to get main page URL. Page might be closed.");
          break;
        }
        
        // If we are back on Claude authorize / redirect callback on the main page
        if (mainUrl.includes("/oauth/code/callback") || mainUrl.includes("/oauth/authorize") || mainUrl.includes("claude.ai/cai/oauth/authorize")) {
          // Check if Allow button is present or if we already have a callback code
          const allowBtn = page.getByRole("button", { name: /allow|authorize|accept|confirm|continue|同意|授权/i }).first();
          if (await allowBtn.isVisible().catch(() => false) || mainUrl.includes("/oauth/code/callback")) {
            console.log("[playwright-oauth] Successfully logged in and redirected back to Claude.");
            loggedIn = true;
            break;
          }
        }
        
        if (targetPage.isClosed()) {
          console.log("[playwright-oauth] Target page closed. Re-binding to main page...");
          targetPage = page;
        }

        if (targetPage.isClosed()) {
          break;
        }

        let url = "";
        try {
          url = targetPage.url();
        } catch (e) {
          console.log("[playwright-oauth] Failed to get target page URL. Page might be closed.");
          break;
        }
        // If we are on Google login pages
        if (url.includes("accounts.google.com")) {
          console.log(`[playwright-oauth] Google sign-in page state: ${url}`);

          // Check for Choose an account card
          const accountCard = targetPage.locator(`[data-email="${opts.email}"], [data-email*="${opts.email}"]`).first();
          if (!accountCardClicked && await accountCard.isVisible().catch(() => false)) {
            console.log("[playwright-oauth] Clicking Choose an Account card...");
            await accountCard.click();
            accountCardClicked = true;
            await page.waitForTimeout(2000);
            continue;
          }
          
          // Check for email input
          const emailInput = targetPage.locator('input[type="email"], input[id="identifierId"]').first();
          if (!emailSubmitted && await emailInput.isVisible().catch(() => false)) {
            const val = await emailInput.inputValue().catch(() => "");
            if (!val) {
              console.log("[playwright-oauth] Entering Google email address...");
              await emailInput.fill(opts.email);
              await targetPage.keyboard.press("Enter");
              emailSubmitted = true;
              await page.waitForTimeout(2000);
            }
            continue;
          }
          
          // Check for password input
          const pwdInput = targetPage.locator('input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])').first();
          if (!passwordSubmitted && await pwdInput.isVisible().catch(() => false)) {
            const val = await pwdInput.inputValue().catch(() => "");
            if (!val && opts.password) {
              console.log("[playwright-oauth] Entering Google password...");
              await pwdInput.fill(opts.password);
              await targetPage.keyboard.press("Enter");
              passwordSubmitted = true;
              await page.waitForTimeout(2000);
            }
            continue;
          }

          // Check for Challenge Selection page
          if (url.includes("/challenge/selection")) {
            if (!challengeSelectionClicked && opts.totpSecret) {
              const totpOption = targetPage.locator('[data-challengetype="6"]').first();
              if (await totpOption.isVisible().catch(() => false)) {
                console.log("[playwright-oauth] Selecting TOTP challenge option...");
                await totpOption.click();
                challengeSelectionClicked = true;
                await page.waitForTimeout(2000);
                continue;
              }
              const textOption = targetPage.locator('li:has-text("Google Authenticator"), li:has-text("Authenticator"), li:has-text("验证器"), li:has-text("驗證器")').first();
              if (await textOption.isVisible().catch(() => false)) {
                console.log("[playwright-oauth] Selecting TOTP option by text...");
                await textOption.click();
                challengeSelectionClicked = true;
                await page.waitForTimeout(2000);
                continue;
              }
            }
            if (!challengeSelectionClicked && opts.recoveryEmail) {
              const recoveryOption = targetPage.locator('li:has-text("Confirm your recovery email"), li:has-text("辅助邮箱"), li:has-text("備用電子郵件"), div[role="link"]:has-text("Confirm your recovery email"), div[role="link"]:has-text("辅助邮箱")').first();
              if (await recoveryOption.isVisible().catch(() => false)) {
                console.log("[playwright-oauth] Selecting Recovery Email challenge option...");
                await recoveryOption.click();
                challengeSelectionClicked = true;
                await page.waitForTimeout(2000);
                continue;
              }
            }
          }

          // Check for TOTP input page
          const totpInput = targetPage.locator('input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]').first();
          if (await totpInput.isVisible().catch(() => false)) {
            const timeSinceLastSubmit = Date.now() - lastTotpSubmitTime;
            if (opts.totpSecret && timeSinceLastSubmit > 15000) {
              console.log("[playwright-oauth] Generating and entering TOTP verification code...");
              const totpCode = generateGoogleTOTP(opts.totpSecret);
              await totpInput.fill(totpCode);
              await targetPage.keyboard.press("Enter");
              lastTotpSubmitTime = Date.now();
              await page.waitForTimeout(2000);
            }
            continue;
          }

          // Check for Recovery Email verification page (usually on /challenge/iap or containing recovery keywords)
          const isRecoveryPage = url.includes("/challenge/iap") || 
                                 await targetPage.evaluate(() => {
                                   const text = document.body?.innerText || '';
                                   return text.includes("recovery email") || 
                                          text.includes("辅助邮箱") || 
                                          text.includes("備用電子郵件") || 
                                          text.includes("khôi phục") || 
                                          text.includes("recuperación") || 
                                          text.includes("récupération");
                                 }).catch(() => false);

          if (isRecoveryPage) {
            const recoveryInput = targetPage.locator([
              'input[name="knowledgePrereqValue"]',
              'input[id="knowledgePrereqValue"]',
              'input[type="email"]',
              'input[type="text"]',
            ].join(", ")).first();

            if (await recoveryInput.isVisible().catch(() => false)) {
              const timeSinceLastSubmit = Date.now() - lastRecoverySubmitTime;
              if (opts.recoveryEmail && timeSinceLastSubmit > 15000) {
                console.log("[playwright-oauth] Confirming recovery email on challenge page...");
                await recoveryInput.fill(opts.recoveryEmail);
                await targetPage.keyboard.press("Enter");
                lastRecoverySubmitTime = Date.now();
                await page.waitForTimeout(2000);
              }
              continue;
            }
          }

          // Debug consent page elements and auto-check checkboxes
          if (url.includes("signin/oauth/id") || url.includes("signin/oauth")) {
            // Log elements for debugging
            const elementsInfo = await targetPage.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], [role="link"]'));
              return buttons.map(el => ({
                tag: el.tagName,
                id: el.id,
                role: el.getAttribute('role'),
                text: (el as HTMLElement).innerText?.trim() || el.getAttribute('value') || '',
                classes: el.className,
              })).filter(e => e.text.length > 0);
            }).catch(() => []);
            console.log(`[playwright-oauth] Consent Page elements: ${JSON.stringify(elementsInfo)}`);

            // Auto-check all unchecked checkboxes
            const checkedCount = await targetPage.evaluate(() => {
              let count = 0;
              const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
              checkboxes.forEach((cb) => {
                const isChecked = cb.tagName === 'INPUT'
                  ? (cb as HTMLInputElement).checked
                  : cb.getAttribute('aria-checked') === 'true';
                if (!isChecked) {
                  (cb as HTMLElement).click();
                  count++;
                }
              });
              return count;
            }).catch(() => 0);
            
            if (checkedCount > 0) {
              console.log(`[playwright-oauth] Checked ${checkedCount} unchecked consent checkboxes.`);
              await page.waitForTimeout(1000);
            }

            // Check for Google OAuth consent screen (Allow/Continue button)
            const consentBtn = targetPage.locator([
              'button:has-text("Continue")',
              'button:has-text("Allow")',
              'button:has-text("继续")',
              'button:has-text("允许")',
              'button:has-text("確定")',
              'button:has-text("同意")',
              'button:has-text("Tiếp tục")',
              'button:has-text("Continuar")',
              'button:has-text("Permitir")',
              'button:has-text("Continuer")',
              'button:has-text("Weiter")',
              'button:has-text("Zulassen")',
              'button:has-text("次へ")',
              'button:has-text("続行")',
              'button:has-text("계속")',
              'button:has-text("허용")',
              'button:has-text("Next")',
              'button:has-text("下一步")',
              'button:has-text("繼續")',
              'button:has-text("允許")',
              '[role="button"]:has-text("Continue")',
              '[role="button"]:has-text("Allow")',
              '[role="button"]:has-text("继续")',
              '[role="button"]:has-text("允许")',
              '[role="button"]:has-text("確定")',
              '[role="button"]:has-text("同意")',
              '[role="button"]:has-text("Tiếp tục")',
              '[role="button"]:has-text("Continuar")',
              '[role="button"]:has-text("Permitir")',
              '[role="button"]:has-text("Continuer")',
              '[role="button"]:has-text("Weiter")',
              '[role="button"]:has-text("Zulassen")',
              '[role="button"]:has-text("次へ")',
              '[role="button"]:has-text("続行")',
              '[role="button"]:has-text("계속")',
              '[role="button"]:has-text("허용")',
              '[role="button"]:has-text("Next")',
              '[role="button"]:has-text("下一步")',
              '[role="button"]:has-text("繼續")',
              '[role="button"]:has-text("允許")',
              '#submit_approve_access',
              '[id*="submit"]',
            ].join(", ")).first();

            const isVisible = await consentBtn.isVisible().catch(() => false);
            const timeSinceLastSubmit = Date.now() - lastConsentSubmitTime;

            if (timeSinceLastSubmit > 15000) {
              if (isVisible) {
                console.log("[playwright-oauth] Clicking Google OAuth consent/allow button via Playwright...");
                await consentBtn.click();
                lastConsentSubmitTime = Date.now();
                await page.waitForTimeout(2000);
                continue;
              } else {
                // Fallback to evaluating JS click if locator is not visible/not found
                const clickedViaJS = await targetPage.evaluate(() => {
                  const keywords = [
                    "continue", "allow", "继续", "允许", "確定", "同意", "tiếp tục", 
                    "continuar", "permitir", "continuer", "weiter", "zulassen", "次へ", "続行", 
                    "계속", "허용", "next", "下一步", "繼續", "允許"
                  ];
                  const elements = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'));
                  for (const el of elements) {
                    const text = ((el as HTMLElement).innerText || el.getAttribute('value') || '').toLowerCase().trim();
                    if (keywords.some(kw => text === kw || text.includes(kw))) {
                      (el as HTMLElement).click();
                      return true;
                    }
                  }
                  // Check span/div
                  const spans = Array.from(document.querySelectorAll('span, div'));
                  for (const el of spans) {
                    const text = ((el as HTMLElement).innerText || '').toLowerCase().trim();
                    if (keywords.some(kw => text === kw)) {
                      const className = el.className || '';
                      if (className.includes('button') || className.includes('btn') || className.includes('VfP3Ux') || el.closest('[role="button"]') || el.closest('button')) {
                        (el as HTMLElement).click();
                        return true;
                      }
                    }
                  }
                  return false;
                }).catch(() => false);

                if (clickedViaJS) {
                  console.log("[playwright-oauth] Clicking Google OAuth consent/allow button via JS Fallback...");
                  lastConsentSubmitTime = Date.now();
                  await page.waitForTimeout(2000);
                  continue;
                }
              }
            }
          }
        }
        
        if (page.isClosed()) {
          break;
        }
        await page.waitForTimeout(2000).catch(() => {});
      }
      
      if (!loggedIn) {
        throw new Error("谷歌账号登录/授权超时，请确认是否在浏览器中完成了手动辅助验证。");
      }
      
      const session = new PlaywrightOAuthSession(browser, context, page, relay || undefined, adspowerOpts);
      return { ok: true, session };
    } else {
      console.log("[playwright-oauth] waiting for login page...");
      const emailInput = await waitForEmailInput(page, 45_000);
      if (!emailInput) {
        const currentUrl = page.url();
        const bodyText = await page.textContent("body").catch(() => "");
        return {
          ok: false,
          error: `登录页未加载出邮箱输入框 (URL: ${currentUrl}, 页面: ${(bodyText || "").slice(0, 300)})`,
        };
      }

      console.log(`[playwright-oauth] filling email: ${opts.email}`);
      await emailInput.fill(opts.email);
      await clickEmailSubmit(page);
      await page.waitForTimeout(2000);

      const bodyText = await page.textContent("body").catch(() => "");
      console.log(`[playwright-oauth] after submit, page text: ${(bodyText || "").slice(0, 200)}`);

      const session = new PlaywrightOAuthSession(browser, context, page, relay || undefined, adspowerOpts);
      return { ok: true, session };
    }
  } catch (err: any) {
    if (context && !opts.adspowerProfileId) try { await context.close(); } catch {}
    if (browser) try { await browser.close(); } catch {}
    if (relay) relay.close();
    if (adspowerOpts) {
      await adspowerOpts.client.closeProfile(adspowerOpts.profileId).catch(() => {});
    }
    return { ok: false, error: `浏览器自动化失败: ${err?.message || err}` };
  }
}

async function waitForEmailInput(page: Page, timeoutMs: number) {
  const selectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="邮箱"]',
    'input[autocomplete="email"]',
    '#email',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function clickEmailSubmit(page: Page): Promise<boolean> {
  const buttonTexts = [
    /continue with email/i,
    /continue/i,
    /send.*link/i,
    /log\s*in/i,
    /sign\s*in/i,
    /submit/i,
    /next/i,
    /继续/,
    /登录/,
    /发送/,
  ];

  for (const text of buttonTexts) {
    const btn = page.getByRole("button", { name: text });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      return true;
    }
  }

  const submitBtn = page.locator('button[type="submit"]');
  if (await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.click();
    return true;
  }

  const form = page.locator("form");
  if (await form.isVisible().catch(() => false)) {
    await form.locator('button, input[type="submit"]').first().click().catch(() => {});
    return true;
  }

  await page.keyboard.press("Enter");
  return true;
}
