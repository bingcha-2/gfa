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

export type PlaywrightOAuthOpts = {
  authorizeUrl: string;
  email: string;
  proxyUrl: string; // socks5://user:pass@host:port
};

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

function startLocalSocksRelay(upstream: { host: string; port: number; userId?: string; password?: string }): Promise<RelayHandle> {
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
    private page: Page,
    private relay: RelayHandle,
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

      await this.page.goto(magicLinkUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

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
    this.relay.close();
  }
}

// ── Trigger (step 1) ─────────────────────────────────────────────────────

function parseUpstream(proxyUrl: string) {
  const url = new URL(proxyUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 1080,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

export async function triggerMagicLinkViaBrowser(opts: PlaywrightOAuthOpts): Promise<TriggerResult> {
  let relay: RelayHandle | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    // 1. Start local SOCKS5 relay
    const upstream = parseUpstream(opts.proxyUrl);
    relay = await startLocalSocksRelay(upstream);
    console.log(`[playwright-oauth] local SOCKS5 relay on 127.0.0.1:${relay.port} → ${upstream.host}:${upstream.port}`);

    // 2. Launch Chromium — headed so the user can see (and CF trusts it more)
    browser = await chromium.launch({
      headless: false,
      proxy: { server: `socks5://127.0.0.1:${relay.port}` },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });

    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();

    // 3. Navigate to authorize URL — Cloudflare JS challenge runs in-browser
    console.log("[playwright-oauth] navigating to authorize URL...");
    await page.goto(opts.authorizeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 4. Wait for login form to appear (after CF challenge resolves)
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

    // 5. Fill email and submit
    console.log(`[playwright-oauth] filling email: ${opts.email}`);
    await emailInput.fill(opts.email);
    await clickEmailSubmit(page);
    await page.waitForTimeout(2000);

    const bodyText = await page.textContent("body").catch(() => "");
    console.log(`[playwright-oauth] after submit, page text: ${(bodyText || "").slice(0, 200)}`);

    const session = new PlaywrightOAuthSession(browser, context, page, relay);
    return { ok: true, session };
  } catch (err: any) {
    if (context) try { await context.close(); } catch {}
    if (browser) try { await browser.close(); } catch {}
    if (relay) relay.close();
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
