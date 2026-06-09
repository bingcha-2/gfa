import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyAwareFetch, proxyRequiredFetch } from "../egress";

afterEach(() => vi.unstubAllGlobals());

describe("proxyRequiredFetch (fail-closed egress)", () => {
  it("refuses to send when no proxy is configured (empty / undefined / blank)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    for (const p of [undefined, null, "", "   "]) {
      await expect(proxyRequiredFetch(p as any, "https://api.anthropic.com/x", {})).rejects.toThrow(
        /egress proxy required/i,
      );
    }
    // Never touched the network — a missing proxy is a hard stop, not a direct call.
    expect(spy).not.toHaveBeenCalled();
  });

  it("delegates to the proxied fetch when a proxy URL is present", async () => {
    // A bad proxy URL throws from proxyDispatcherFor — proves we attempted to build
    // a dispatcher (i.e. did NOT silently go direct) rather than calling bare fetch.
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(proxyRequiredFetch("not-a-valid-url", "https://api.anthropic.com/x", {})).rejects.toThrow(
      /invalid proxyUrl/i,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("proxyAwareFetch (best-effort egress)", () => {
  it("falls back to a direct global fetch when no proxy is configured", async () => {
    const spy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const res = await proxyAwareFetch(undefined, "https://chatgpt.com/x", { method: "GET" });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1); // direct call IS allowed here
  });
});
