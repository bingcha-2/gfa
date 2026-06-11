// Low-level JSON file store helpers shared across the rosetta domain services.
// Extracted verbatim from rosetta.service.ts (behavior-preserving).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function defaultDataDir(): string {
  if (process.env.ROSETTA_DATA_DIR) return process.env.ROSETTA_DATA_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta");
}

export function readJson(filePath: string, fallback: any): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/** mtime-based file cache: skips re-read if file hasn't changed on disk. */
export class CachedJsonFile {
  private cache: any = null;
  private mtimeMs = 0;

  constructor(private readonly filePath: string, private readonly fallback: any) {}

  read(): any {
    try {
      const stat = fs.statSync(this.filePath);
      if (this.cache !== null && stat.mtimeMs === this.mtimeMs) {
        return this.cache;
      }
      this.mtimeMs = stat.mtimeMs;
    } catch {
      return this.fallback;
    }
    this.cache = readJson(this.filePath, this.fallback);
    return this.cache;
  }

  /** Invalidate cache so next read() re-reads from disk. */
  invalidate(): void {
    this.cache = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalize a raw exit-proxy string into a canonical proxy URL.
 * Accepts:
 *   - full URLs: http(s):// , socks5(h):// (returned as-is)
 *   - shorthand host:port:user:pass  -> http://user:pass@host:port
 *   - shorthand host:port            -> http://host:port
 * Empty/blank -> "" (caller treats as "clear the proxy").
 *
 * Mirrors the scheme set understood by lease-core/egress.ts (server-side token
 * refresh) and the Wails client's egress dialer.
 */
export function normalizeProxyUrl(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^(https?|socks5h?):\/\//i.test(s)) return s;
  const p = s.split(":");
  if (p.length === 4) return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`; // host:port:user:pass
  if (p.length === 2) return `http://${p[0]}:${p[1]}`; // host:port(无鉴权)
  return s;
}

/**
 * SOCKS5-forcing variant of normalizeProxyUrl for Anthropic, whose egress MUST be
 * SOCKS5 (the static residential exit). Unlike normalizeProxyUrl (which defaults
 * bare host:port forms to http for codex/antigravity), this coerces EVERYTHING to
 * socks5://, so whatever an operator types in the console always exits via SOCKS5:
 *   - socks4/5(h):// URL            -> as-is
 *   - http(s):// URL                -> scheme rewritten to socks5://
 *   - host:port:user:pass           -> socks5://user:pass@host:port
 *   - host:port / user:pass@host:port (no scheme) -> socks5:// prefixed
 * Empty/blank -> "".
 */
export function toSocks5ProxyUrl(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^socks[45]h?:\/\//i.test(s)) return s;            // already socks
  if (/^https?:\/\//i.test(s)) return s.replace(/^https?:\/\//i, "socks5://");
  const p = s.split(":");
  if (p.length === 4) return `socks5://${p[2]}:${p[3]}@${p[0]}:${p[1]}`; // host:port:user:pass
  return `socks5://${s}`;                                  // host:port 或 user:pass@host:port
}

/**
 * Set (or clear, when proxyUrl is blank) the sticky exit proxy on one account in
 * a provider's `{accounts:[...]}` JSON pool. Generic across providers — the only
 * difference is the pool file path. Returns the affected account's email + the
 * normalized proxy that was stored (empty string when cleared).
 */
export function setAccountProxyInPool(
  filePath: string,
  accountId: number,
  rawProxyUrl: unknown,
): { ok: true; email: string; proxyUrl: string } | { ok: false; error: string } {
  const proxyUrl = normalizeProxyUrl(rawProxyUrl);
  if (proxyUrl && !/^(https?|socks5h?):\/\//i.test(proxyUrl)) {
    return { ok: false, error: "代理格式无效:用 host:port:user:pass(或 host:port),或 http(s):// / socks5:// URL" };
  }
  const data = readJson(filePath, { accounts: [] });
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const account = accounts.find((item: any) => Number(item.id) === accountId);
  if (!account) return { ok: false, error: "账号不存在" };
  if (proxyUrl) account.proxyUrl = proxyUrl;
  else delete account.proxyUrl;
  writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
  return { ok: true, email: String(account.email || ""), proxyUrl };
}
