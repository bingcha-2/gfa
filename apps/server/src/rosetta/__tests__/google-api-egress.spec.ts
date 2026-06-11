import { afterEach, describe, expect, it, vi } from "vitest";

// Every google-api request carries the account's OAuth token (refresh_token or
// Bearer accessToken) to Google, so when the account has a sticky exit proxy the
// request MUST egress through it — same IP as inference — instead of leaking the
// datacenter IP. antigravity egress is best-effort (proxyAwareFetch), so a
// proxy-less account still goes direct. We mock egress to capture the proxyUrl.
const { egressFetch } = vi.hoisted(() => ({ egressFetch: vi.fn() }));
vi.mock("../../lease-core/egress", () => ({
  proxyAwareFetch: (proxyUrl: unknown, url: string, init: any) => egressFetch(proxyUrl, url, init),
  proxyRequiredFetch: (proxyUrl: unknown, url: string, init: any) => egressFetch(proxyUrl, url, init),
}));

import { discoverProject, fetchAccountHealth, fetchAvailableModels, refreshAccessToken } from "../google-api";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("google-api egress — token-bearing requests route through the account proxy", () => {
  afterEach(() => vi.clearAllMocks());

  it("refreshAccessToken sends the OAuth refresh through the account proxy", async () => {
    egressFetch.mockResolvedValue(ok({ access_token: "at", expires_in: 3600 }));
    await refreshAccessToken("rt", "http://proxy:1");
    expect(egressFetch).toHaveBeenCalledWith(
      "http://proxy:1",
      expect.stringContaining("oauth2.googleapis.com/token"),
      expect.anything(),
    );
  });

  it("fetchAccountHealth sends loadCodeAssist through the account proxy", async () => {
    egressFetch.mockResolvedValue(ok({ paidTier: {} }));
    await fetchAccountHealth("at", "proj", "e@x.com", undefined, "http://proxy:1");
    expect(egressFetch).toHaveBeenCalledWith(
      "http://proxy:1",
      expect.stringContaining("loadCodeAssist"),
      expect.anything(),
    );
  });

  it("fetchAvailableModels sends through the account proxy", async () => {
    egressFetch.mockResolvedValue(ok({ models: {} }));
    await fetchAvailableModels("at", "proj", undefined, "http://proxy:1");
    expect(egressFetch).toHaveBeenCalledWith(
      "http://proxy:1",
      expect.stringContaining("fetchAvailableModels"),
      expect.anything(),
    );
  });

  it("discoverProject sends onboardUser through the account proxy", async () => {
    egressFetch.mockResolvedValue(ok({ done: true, response: { cloudaicompanionProject: { id: "proj-1" } } }));
    await discoverProject("at", undefined, "http://proxy:1");
    expect(egressFetch).toHaveBeenCalledWith(
      "http://proxy:1",
      expect.stringContaining("onboardUser"),
      expect.anything(),
    );
  });

  it("falls back to direct (proxy undefined) when the account has no proxy — best-effort, not fail-closed", async () => {
    egressFetch.mockResolvedValue(ok({ access_token: "at", expires_in: 3600 }));
    await refreshAccessToken("rt");
    expect(egressFetch).toHaveBeenCalledWith(undefined, expect.anything(), expect.anything());
  });
});
