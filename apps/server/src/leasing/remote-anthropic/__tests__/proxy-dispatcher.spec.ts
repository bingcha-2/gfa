import { describe, expect, it } from "vitest";

import { proxyDispatcherFor } from "../../lease-core/egress";

describe("proxyDispatcherFor", () => {
  it("returns undefined for empty/blank proxy (direct connection)", () => {
    expect(proxyDispatcherFor("")).toBeUndefined();
    expect(proxyDispatcherFor("   ")).toBeUndefined();
    expect(proxyDispatcherFor(undefined)).toBeUndefined();
    expect(proxyDispatcherFor(null)).toBeUndefined();
  });

  it("builds a dispatcher for http and https proxies", () => {
    expect(proxyDispatcherFor("http://user:pass@127.0.0.1:8080")).toBeDefined();
    expect(proxyDispatcherFor("https://127.0.0.1:8443")).toBeDefined();
  });

  it("builds a dispatcher for socks5 / socks5h / socks4 proxies", () => {
    expect(proxyDispatcherFor("socks5://u:p@10.0.0.1:1080")).toBeDefined();
    expect(proxyDispatcherFor("socks5h://10.0.0.1:1080")).toBeDefined();
    expect(proxyDispatcherFor("socks4://10.0.0.1:1080")).toBeDefined();
  });

  it("caches one dispatcher per distinct proxy url", () => {
    const a = proxyDispatcherFor("http://cache.example:3128");
    const b = proxyDispatcherFor("http://cache.example:3128");
    expect(a).toBe(b);
  });

  it("throws (no silent direct fallback) on an unparseable url", () => {
    expect(() => proxyDispatcherFor("not a url")).toThrow(/invalid proxyUrl/);
  });

  it("throws on an unsupported scheme", () => {
    expect(() => proxyDispatcherFor("ftp://10.0.0.1:21")).toThrow(/unsupported proxy scheme/);
  });
});
