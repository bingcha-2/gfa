// Fetch the latest Anthropic "Secure link to log in to Claude.ai" magic-link URL
// by logging into mail.com's WEB mailbox over plain HTTP — used when IMAP is
// disabled on the account (mail.com free/bulk accounts have IMAP off by default,
// so LOGIN returns "authentication failed" even with the correct password).
//
// The whole flow is pure server-side HTTP — no JS engine, no headless browser,
// no captcha — because mail.com ships a no-JavaScript "lightmailer" webmail that
// renders the inbox as plain HTML:
//
//   1. GET  www.mail.com                 -> JSESSIONID + per-session `statistics` token
//   2. POST login.mail.com/login         -> 303 to navigator-*.mail.com/login?ott=...
//   3. follow ott -> meta-refresh        -> lightmailer.mail.com/start (SESSION cookie)
//   4. GET  lightmailer /folderlist       -> INBOX messagelist link (folderId)
//   5. GET  /messagelist?folderId=...     -> newest "Secure link to log in to Claude.ai"
//   6. GET  /messagedetail?...            -> <iframe src="./mailbody/<id>/false">
//   7. GET  /mailbody/<id>/false          -> mail.com "deref" wrapper -> unwrap to the
//                                            real https://claude.ai/magic-link#... URL
//
// Returns the same shape as imap-magic-link.ts so callers can swap transports.

import { proxyAwareFetch } from "../../lease-core/egress";

export type WebMagicLinkCreds = {
  email: string;
  password: string;
  // Optional egress proxy. Mail fetching normally goes direct (it carries no
  // Anthropic token), but a residential IP can avoid datacenter-IP blocks.
  proxyUrl?: string;
  // Only accept a magic-link email received at/after this epoch-ms. Prevents
  // grabbing a STALE link from a previous login (magic links expire ~15 min).
  // Derived per-message from the mailId (its leading 13 digits = receipt ms),
  // which is timezone-free — unlike the human-readable date in the list UI.
  sinceMs?: number;
  // If set, poll the inbox until a qualifying email arrives or this many ms
  // elapse (email delivery lags the trigger by a few seconds).
  waitMs?: number;
};

export type MagicLinkResult = {
  ok: boolean;
  url?: string;
  subject?: string;
  date?: string;
  error?: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 12;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&#0?34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Minimal cookie jar. mail.com spreads its session across www/login/navigator/
// lightmailer hosts (all *.mail.com); the browser-equivalent behavior that works
// here is "send every cookie we've collected to every *.mail.com host".
class CookieJar {
  private store = new Map<string, string>();
  absorb(res: Response) {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const sc of list) {
      const pair = sc.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export async function fetchAnthropicMagicLinkViaWeb(creds: WebMagicLinkCreds): Promise<MagicLinkResult> {
  const jar = new CookieJar();
  const proxyUrl = creds.proxyUrl?.trim() || "";

  const raw = (url: string, init: RequestInit): Promise<Response> => {
    const headers = { "user-agent": UA, cookie: jar.header(), ...(init.headers as Record<string, string>) };
    const withTimeout: RequestInit = { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    return proxyUrl ? proxyAwareFetch(proxyUrl, url, withTimeout) : fetch(url, withTimeout);
  };

  // GET that follows Location redirects AND <meta http-equiv=refresh> hops,
  // absorbing cookies at each hop. Returns the final response + body + url.
  const navigate = async (
    startUrl: string,
    referer: string,
  ): Promise<{ status: number; body: string; url: string }> => {
    let url = startUrl;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const res = await raw(url, { method: "GET", redirect: "manual", headers: { referer } });
      jar.absorb(res);
      const loc = res.headers.get("location");
      if (loc) {
        url = new URL(decodeEntities(loc), url).href;
        continue;
      }
      const body = await res.text();
      const meta = body.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (meta) {
        url = new URL(decodeEntities(meta[1].replace(/['"]+$/, "")), url).href;
        continue;
      }
      return { status: res.status, body, url };
    }
    throw new Error("重定向次数过多");
  };

  try {
    // 1. Homepage -> JSESSIONID + statistics token
    const home = await raw("https://www.mail.com/", { method: "GET", redirect: "manual", headers: {} });
    jar.absorb(home);
    const homeHtml = await home.text();
    const statistics = homeHtml.match(/name="statistics"\s+value="([^"]*)"/)?.[1] || "";
    if (!statistics) return { ok: false, error: "无法获取 mail.com 登录令牌(statistics),页面结构可能已变" };

    // 2. POST credentials
    const loginBody = new URLSearchParams({
      ibaInfo: "",
      service: "mailint",
      statistics,
      uasServiceID: "mc_starter_mailcom",
      successURL: "https://$(clientName)-$(dataCenter).mail.com/login",
      loginFailedURL: "https://www.mail.com/logout/?ls=wd",
      loginErrorURL: "https://www.mail.com/logout/?ls=te",
      edition: "us",
      lang: "en",
      usertype: "standard",
      username: creds.email,
      password: creds.password,
    });
    const login = await raw("https://login.mail.com/login", {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.mail.com",
        referer: "https://www.mail.com/",
      },
      body: loginBody,
    });
    jar.absorb(login);
    const ott = login.headers.get("location");
    if (!ott || /\/logout|ls=wd|ls=te/.test(ott)) {
      // ls=wd = wrong-data (bad creds / blocked); ls=te = technical-error
      return {
        ok: false,
        error: "mail.com 网页登录被拒(账号密码错误,或该号被风控/需验证)",
      };
    }

    // 3. Follow ott -> navigator -> lightmailer/start (establishes SESSION cookie)
    const startUrl = (await navigate(ott, "https://www.mail.com/")).url;
    if (!/lightmailer\.mail\.com/.test(startUrl)) {
      return { ok: false, error: `登录后未进入轻量版邮箱(落在 ${startUrl.slice(0, 80)})` };
    }

    // 4. Folder list -> INBOX messagelist link (resolved once; reused while polling)
    const folders = await navigate("https://lightmailer.mail.com/folderlist?tep=startup&fcs=true", startUrl);
    const inboxHref = folders.body.match(/href="([^"]*messagelist\?folderId=[^"]+)"/i)?.[1];
    if (!inboxHref) return { ok: false, error: "未找到收件箱(folderlist 无 messagelist 链接)" };
    const inboxUrl = new URL(decodeEntities(inboxHref), "https://lightmailer.mail.com/").href;

    // Scan the inbox once: find the newest Claude magic-link email that is NOT
    // older than sinceMs (timestamp from the mailId), then open it and unwrap
    // the link. Returns null if no qualifying email is present yet.
    const sinceMs = creds.sinceMs && creds.sinceMs > 0 ? creds.sinceMs : 0;
    const TOLERANCE_MS = 60_000; // clock skew between us and mail.com
    const scanOnce = async (): Promise<{ result: MagicLinkResult; stale: boolean } | null> => {
      const inbox = await navigate(inboxUrl, startUrl);
      const items = [
        ...inbox.body.matchAll(
          /href="([^"]*messagedetail[^"]*mailId=(\d+)[^"]*)"[^>]*>\s*(?:<[^>]+>\s*)*Open E-mail:\s*([^<]+)</gi,
        ),
      ].map((m) => ({
        href: decodeEntities(m[1]),
        mailId: m[2],
        ts: mailIdToEpochMs(m[2]),
        subject: decodeEntities(m[3]).trim(),
      }));

      const isMagic = (s: string) =>
        /secure link to log in to claude/i.test(s) ||
        (/claude\.ai|anthropic/i.test(s) && /log in|sign in|secure link/i.test(s));
      // messagelist is newest-first; the first match is the newest magic email.
      const newest = items.find((i) => isMagic(i.subject));
      if (!newest) return null;

      // Freshness gate: reject a link that predates this attempt's trigger.
      if (sinceMs && newest.ts && newest.ts < sinceMs - TOLERANCE_MS) {
        return { stale: true, result: { ok: false, error: "" } };
      }

      const detailUrl = new URL(newest.href, "https://lightmailer.mail.com/").href;
      const detail = await navigate(detailUrl, inboxUrl);
      const iframe = detail.body.match(/<iframe[^>]*src="([^"]+)"/i)?.[1];
      const bodyHtml = iframe
        ? (await navigate(new URL(decodeEntities(iframe), detailUrl).href, detailUrl)).body
        : detail.body;
      const url = extractMagicLink(bodyHtml);
      if (!url) return { stale: false, result: { ok: false, error: "邮件正文中未找到 Claude 登录链接" } };

      const [subjectText] = newest.subject.split("|");
      return {
        stale: false,
        result: {
          ok: true,
          url,
          subject: subjectText.trim(),
          date: newest.ts ? new Date(newest.ts).toISOString() : "",
        },
      };
    };

    // 5-7. Poll until a qualifying email arrives (or waitMs elapses).
    const deadline = Date.now() + (creds.waitMs && creds.waitMs > 0 ? creds.waitMs : 0);
    for (;;) {
      const hit = await scanOnce();
      if (hit && !hit.stale) return hit.result; // found a fresh link (or a hard parse error)
      if (Date.now() >= deadline) {
        if (sinceMs) return { ok: false, error: "未找到触发时间之后的新登录邮件(请确认已触发发送,稍等几秒重试)" };
        return { ok: false, error: "收件箱未找到 Claude 登录邮件(请先触发登录/OAuth 再获取)" };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (err: any) {
    const message = String(err?.message || err);
    if (/timed out|timeout|aborted/i.test(message)) {
      return { ok: false, error: `mail.com 网页访问超时: ${message}` };
    }
    return { ok: false, error: `mail.com 网页抓取失败: ${message}` };
  }
}

// Pull the real Claude magic link out of the mail body. mail.com wraps outbound
// links in a tracking redirect: /<id>/deref/?redirectUrl=<url-encoded real url>.
// Prefer unwrapping that to the direct claude.ai link; fall back to any direct link.
function extractMagicLink(html: string): string | null {
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));

  // 1. deref wrapper whose redirectUrl points at the claude magic link
  for (const href of hrefs) {
    const m = href.match(/[?&]redirectUrl=([^&]+)/i);
    if (m) {
      const target = safeDecode(m[1]);
      if (/login_magic_link|auth\/magic|claude\.ai\/magic|claude\.ai|anthropic\.com/i.test(target)) {
        return target;
      }
    }
  }
  // 2. a direct magic-link path
  for (const href of hrefs) {
    if (/login_magic_link|auth\/magic|claude\.ai\/magic-link/i.test(href)) return href;
  }
  // 3. any claude.ai / anthropic.com link that looks auth-related
  for (const href of hrefs) {
    if (/(claude\.ai|anthropic\.com)/i.test(href) && /(login|magic|token|auth|sign)/i.test(href)) return href;
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// mail.com mailIds embed the receipt time: the leading 13 digits are epoch ms
// (UTC), e.g. 1781022681779955 -> 1781022681779 -> 2026-06-09. This is a
// timezone-free timestamp, unlike the localized date shown in the list UI.
// Returns 0 if the id doesn't look like a millisecond-prefixed value.
function mailIdToEpochMs(mailId: string): number {
  const digits = String(mailId || "").replace(/\D/g, "");
  if (digits.length < 13) return 0;
  const ms = Number(digits.slice(0, 13));
  // sanity window: 2015-01-01 .. 2100-01-01
  if (!Number.isFinite(ms) || ms < 1420070400000 || ms > 4102444800000) return 0;
  return ms;
}
