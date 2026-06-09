// Generic per-account egress (exit-proxy) plumbing, shared by every provider.
//
// An account may carry a sticky exit proxy (residential IP). When set, BOTH the
// server-side OAuth token refresh AND the client-side inference must leave from
// that one IP — if refresh goes out from the datacenter IP while inference goes
// out from a residential IP, the mismatch is itself an anti-abuse signal that
// can get the OAuth session revoked. proxyAwareFetch() is how the token-refresh
// path pins its egress; the Wails client pins inference egress from the
// `accountProxyUrl` field surfaced on the lease response.
//
// Supported schemes (mirrors normalizeProxyUrl in rosetta/lib/store.ts, which
// accepts http(s) and socks and defaults bare host:port forms to http):
//   http, https             -> ProxyAgent (HTTP CONNECT tunnel)
//   socks, socks5, socks5h  -> socksDispatcher type 5
//   socks4, socks4a         -> socksDispatcher type 4
//
// A non-empty but unparseable/unsupported proxy URL THROWS rather than returning
// undefined: a proxy is configured for IP pinning, so we must NOT silently fall
// back to a direct (datacenter-IP) connection.

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";

// Cache dispatchers by proxy URL. Each ProxyAgent/socksDispatcher owns a
// connection pool, so we reuse one per distinct proxy instead of leaking a fresh
// pool on every refresh (refreshes recur ~hourly per account).
const dispatcherCache = new Map<string, Dispatcher>();

export function proxyDispatcherFor(rawProxyUrl: string | undefined | null): Dispatcher | undefined {
  const proxyUrl = String(rawProxyUrl || "").trim();
  if (!proxyUrl) return undefined; // no proxy on this account -> direct connection

  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`invalid proxyUrl: ${proxyUrl}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

  let dispatcher: Dispatcher;
  if (scheme === "http" || scheme === "https") {
    dispatcher = new ProxyAgent({ uri: proxyUrl });
  } else if (
    scheme === "socks" || scheme === "socks5" || scheme === "socks5h" ||
    scheme === "socks4" || scheme === "socks4a"
  ) {
    const type: 4 | 5 = scheme.startsWith("socks4") ? 4 : 5;
    dispatcher = socksDispatcher({
      type,
      host: parsed.hostname,
      port: Number(parsed.port) || 1080,
      ...(parsed.username ? { userId: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    });
  } else {
    throw new Error(`unsupported proxy scheme "${scheme}" in proxyUrl: ${proxyUrl}`);
  }

  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * fetch() that routes through an account's exit proxy when one is configured.
 *
 * With a proxy we use the installed undici's fetch so it can carry that undici's
 * Dispatcher — Node's bundled fetch rejects a dispatcher from a different undici
 * major ("invalid onRequestStart method"). With NO proxy we use the global fetch:
 * it's the common path, the original behavior, and stays stubbable by tests
 * (vi.stubGlobal). A bad/unsupported proxy URL throws (never silent direct
 * fallback) so a misconfigured exit proxy fails loudly instead of leaking the
 * datacenter IP.
 */
export async function proxyAwareFetch(
  proxyUrl: string | undefined | null,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const dispatcher = proxyDispatcherFor(proxyUrl);
  const withDispatcher: RequestInit & { dispatcher?: unknown } = { ...init };
  if (dispatcher) withDispatcher.dispatcher = dispatcher;
  const fetchImpl = (dispatcher ? undiciFetch : fetch) as typeof fetch;
  return fetchImpl(url, withDispatcher);
}

/**
 * Fail-closed variant of proxyAwareFetch: REFUSE to send when no proxy is
 * configured, instead of falling back to a direct datacenter-IP connection.
 *
 * For an account whose egress policy is "required" (anthropic), every upstream
 * request that carries the account's OAuth token — token refresh, usage/profile
 * probe, model-catalog fetch — must leave from the account's sticky residential
 * IP. A token-bearing request from the datacenter IP, while inference comes from
 * a residential IP, is itself an anti-abuse signal that can get the OAuth session
 * revoked. So a missing proxy is a hard error here, never a silent direct call.
 */
export async function proxyRequiredFetch(
  proxyUrl: string | undefined | null,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (!String(proxyUrl || "").trim()) {
    throw new Error(
      "egress proxy required but none configured for this account — refusing to leave from the datacenter IP",
    );
  }
  return proxyAwareFetch(proxyUrl, url, init);
}
