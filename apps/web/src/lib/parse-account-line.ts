// Parse a pasted Anthropic account line into structured credentials.
//
// Supports the several formats operators paste, in any mix of separators:
//   - 3 段同行:  email----password----sk-ant-sid02-…
//   - 5 段同行:  email----password----recovery----totp----codeUrl----sk-ant-sid02-…
//   - 4 段 + 换行: email---password---recovery---xxx \n sk-ant-sid02-…
// Separators seen in the wild: `----` (4), `---` (3), `--` (2). The sessionKey
// may sit on the same line as the last field OR on its own line below.
//
// Only `sessionKey` + 邮箱 are strictly required by the SK-direct-login path;
// password/recovery/totp are best-effort (used by the magic-link fallback).
// Misclassifying a recovery password as a TOTP secret is harmless for SK login.

export type ParsedAccountLine = {
  email: string;
  password: string;
  recoveryEmail: string;
  totpSecret: string;
  sessionKey: string;
};

// claude.ai web session cookie token. Currently only sid02 is issued, but we
// tolerate sid01/future sid0x so a numbering bump doesn't silently drop the key.
const SESSION_KEY_RE = /sk-ant-sid\d{2}-[A-Za-z0-9\-_]+/;

// Order matters: longer runs first so `----` isn't split as two `--`.
const SEPARATOR_RE = /----+|---+|--/;

// A base32-ish secret (TOTP / app password): A–Z and digits 2–7, 16–40 chars.
const TOTP_LIKE_RE = /^[a-zA-Z2-7]+$/;

export function parseAccountLine(raw: string): ParsedAccountLine | null {
  const text = (raw || "").trim();
  if (!text) return null;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let email = "";
  let password = "";
  let recoveryEmail = "";
  let totpSecret = "";
  let sessionKey = "";

  // 1. SessionKey can be anywhere — its own line, or embedded in the creds line.
  //    Prefer a clean regex extraction; fall back to the raw matching line.
  const sessionKeyLine = lines.find((l) => l.includes("sk-ant-"));
  if (sessionKeyLine) {
    sessionKey = sessionKeyLine.match(SESSION_KEY_RE)?.[0] || sessionKeyLine;
  }

  // 2. The credentials line is the first line with an "@" that isn't the bare
  //    sessionKey line; fall back to the first line.
  const credsLine = lines.find((l) => l.includes("@") && !l.startsWith("sk-ant-")) || lines[0];
  if (credsLine) {
    const parts = credsLine.split(SEPARATOR_RE);
    if (parts.length >= 2) {
      email = parts[0]?.trim() || "";
      password = parts[1]?.trim() || "";

      for (let i = 2; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;

        if (part.startsWith("sk-ant-")) {
          // SK on the same line — prefer the exact token (split keeps it intact).
          sessionKey = part.match(SESSION_KEY_RE)?.[0] || part;
        } else if (part.includes("@")) {
          recoveryEmail = part;
        } else if (part.length >= 16 && part.length <= 40 && TOTP_LIKE_RE.test(part)) {
          totpSecret = part;
        } else if (parts.length === 3 && i === 2 && !sessionKey) {
          // 3-段格式且第三段不是邮箱/TOTP/URL → 当作 sessionKey 兜底。
          sessionKey = part;
        }
        // else: noise (code-fetch URL, etc.) — ignored.
      }
    }
  }

  // 3. Last-resort: a trailing line that looks like a key but wasn't matched above.
  if (!sessionKey && lines.length > 1) {
    const lastLine = lines[lines.length - 1];
    if (lastLine.startsWith("sk-ant-") || lastLine.length > 50) {
      sessionKey = lastLine.match(SESSION_KEY_RE)?.[0] || lastLine;
    }
  }

  return { email, password, recoveryEmail, totpSecret, sessionKey };
}
