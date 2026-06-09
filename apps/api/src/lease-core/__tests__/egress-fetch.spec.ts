import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyAwareFetch } from "../egress";

// proxyAwareFetch 是三家服务端刷 token 的共用出口:有账号代理 → 经 undici dispatcher 出站
// (与推理同 IP);无代理 → 走全局 fetch(常路径,可被测试 stub)。这里锁定分支选择本身。
describe("proxyAwareFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the global fetch (the common, stubbable path) when no proxy is configured", async () => {
    const spy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const res = await proxyAwareFetch("", "https://api.example/token", { method: "POST" });

    expect(spy).toHaveBeenCalledOnce();
    expect(await res.text()).toBe("ok");
  });

  it("does NOT use the global fetch when a proxy is set — it routes via the undici dispatcher", async () => {
    const spy = vi.fn(async () => {
      throw new Error("global fetch must not be used when an exit proxy is configured");
    });
    vi.stubGlobal("fetch", spy);

    // Dead proxy → undici attempts a real connection and fails. The point of the test is
    // that the global stub is never reached (proving the proxied branch was taken).
    await expect(
      proxyAwareFetch("http://127.0.0.1:1", "https://api.example/token", { method: "POST" }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on an unsupported proxy scheme rather than silently going direct (no IP leak)", async () => {
    const spy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", spy);

    await expect(proxyAwareFetch("ftp://h:1", "https://api.example/token", {})).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
