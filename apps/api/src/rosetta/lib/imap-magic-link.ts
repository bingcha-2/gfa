// Fetch the latest Anthropic "Sign in to Claude.ai" magic-link URL from a
// mail.com (or any IMAP) inbox. Used by the Claude OAuth flow to avoid manual
// email checking: trigger login → poll this → open the returned URL.

import { ImapFlow } from "imapflow";

export type ImapCredentials = {
  host?: string;
  port?: number;
  email: string;
  password: string;
};

export type MagicLinkResult = {
  ok: boolean;
  url?: string;
  subject?: string;
  date?: string;
  error?: string;
};

const DEFAULT_HOST = "imap.mail.com";
const DEFAULT_PORT = 993;
const CONNECT_TIMEOUT_MS = 15_000;

function extractMagicLink(html: string): string | null {
  // The Anthropic email contains an <a> tag whose visible text or href points
  // to the magic-link endpoint. We look for the href inside a link that
  // contains "Sign in" or points to claude.ai/anthropic login URLs.
  // Pattern 1: href containing the login/magic-link path
  const hrefRe = /href=["']([^"']*(?:login_magic_link|auth\/magic)[^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html))) {
    const url = decodeEntities(match[1]);
    if (url.startsWith("http")) return url;
  }
  // Pattern 2: any claude.ai / anthropic.com link that looks like a sign-in
  const claudeRe = /href=["']([^"']*(?:claude\.ai|anthropic\.com)[^"']*)["']/gi;
  while ((match = claudeRe.exec(html))) {
    const url = decodeEntities(match[1]);
    if (/sign|login|auth|magic|token/i.test(url)) return url;
  }
  // Pattern 3: broad — any link whose visible text contains "Sign in"
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
  while ((match = linkRe.exec(html))) {
    const body = match[0];
    if (/sign\s*in/i.test(body)) return decodeEntities(match[1]);
  }
  return null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// imapflow 把真正的失败原因塞在错误对象的多个字段里,而不是 .message
// (.message 常常只是笼统的 "Command failed")。把它们全挖出来拼成可诊断信息。
function describeImapError(err: any): string {
  const parts: string[] = [];
  const base = String(err?.message || err || "未知错误");
  parts.push(base);
  // 服务器原文响应 / 状态码 —— 最有用,直接是 mail.com 的拒绝理由
  const serverText = err?.responseText || err?.response;
  if (serverText && String(serverText) !== base) parts.push(`server="${String(serverText).trim()}"`);
  if (err?.serverResponseCode) parts.push(`code=${err.serverResponseCode}`);
  if (err?.command) parts.push(`command=${err.command}`);
  if (err?.code && err.code !== err?.serverResponseCode) parts.push(`errno=${err.code}`);
  if (err?.authenticationFailed) parts.push("authenticationFailed=true");
  return parts.join(" | ");
}

export async function fetchAnthropicMagicLink(creds: ImapCredentials): Promise<MagicLinkResult> {
  const client = new ImapFlow({
    host: creds.host || DEFAULT_HOST,
    port: creds.port || DEFAULT_PORT,
    secure: true,
    auth: { user: creds.email, pass: creds.password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Search for recent Anthropic emails, newest first.
      // "Secure link to log in to Claude.ai" is the typical subject.
      let searchUids: number[] = [];
      try {
        const r = await client.search({ from: "noreply@anthropic.com", seen: false }, { uid: true });
        if (Array.isArray(r)) searchUids = r;
      } catch {}

      // Fallback: broader search if nothing found
      if (!searchUids.length) {
        try {
          const r = await client.search({ from: "anthropic.com" }, { uid: true });
          if (Array.isArray(r)) searchUids = r;
        } catch {}
      }

      if (!searchUids.length) {
        return { ok: false, error: "收件箱未找到 Anthropic 邮件" };
      }

      // Take the newest (highest UID)
      const latestUid = Math.max(...searchUids);
      const fetchResult = await client.fetchOne(String(latestUid), {
        source: true,
        envelope: true,
        uid: true,
      });

      if (!fetchResult) {
        return { ok: false, error: "无法读取邮件内容" };
      }
      const msg = fetchResult;

      if (!msg.source) {
        return { ok: false, error: "无法读取邮件内容" };
      }

      const raw = msg.source.toString("utf8");
      const url = extractMagicLink(raw);
      if (!url) {
        return { ok: false, error: "邮件中未找到登录链接" };
      }

      return {
        ok: true,
        url,
        subject: msg.envelope?.subject || "",
        date: msg.envelope?.date?.toISOString() || "",
      };
    } finally {
      lock.release();
    }
  } catch (err: any) {
    const detail = describeImapError(err);
    // 认证失败:密码错 / mail.com 后台未开启 IMAP 访问 / 需要应用专用密码
    if (err?.authenticationFailed || /AUTHENTICATIONFAILED|auth|login|credential|password/i.test(detail)) {
      return {
        ok: false,
        error: `邮箱认证失败(检查密码,并确认 mail.com 后台已开启 IMAP 访问): ${detail}`,
      };
    }
    // 连接/超时类
    if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND| closed/i.test(detail)) {
      return { ok: false, error: `IMAP 连接失败(网络/主机/端口): ${detail}` };
    }
    return { ok: false, error: `IMAP 错误: ${detail}` };
  } finally {
    try { await client.logout(); } catch {}
  }
}
