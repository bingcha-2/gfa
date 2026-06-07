// Build an undici Dispatcher that routes an outbound request through a per-account
// exit proxy (residential-IP pinning). Used by the server-side OAuth token refresh
// so the refresh call leaves from the SAME IP the client uses for inference — if
// refresh instead goes out from the datacenter IP, the IP/fingerprint mismatch is
// itself an anti-abuse signal that can get the OAuth session revoked.
//
// Supported schemes (mirrors rosetta.service.ts normalizeProxyUrl, which accepts
// http(s) and socks5h and defaults bare host:port forms to http):
//   http, https             -> ProxyAgent (HTTP CONNECT tunnel, like the Wails
//                              client's leaser.go ConnectViaProxy)
//   socks, socks5, socks5h  -> socksDispatcher type 5
//   socks4, socks4a         -> socksDispatcher type 4
//
// A non-empty but unparseable/unsupported proxy URL THROWS rather than returning
// undefined: a proxy is configured for IP pinning, so we must NOT silently fall
// back to a direct (datacenter-IP) connection.

import { ProxyAgent, type Dispatcher } from "undici";
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
