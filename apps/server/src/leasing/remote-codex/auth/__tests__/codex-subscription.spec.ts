import { afterEach, describe, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock("../../../lease-core/egress", () => ({ proxyAwareFetch: upstream }));
import { fetchCodexSubscription, parseCodexSubscriptionAccount, subscriptionExpiryIso } from "../codex-subscription";

const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "owner" } })).toString("base64url")}.x`;
const response = (payload: unknown) => new Response(JSON.stringify(payload));
afterEach(() => vi.clearAllMocks());

describe("mother account subscription expiry", () => {
  it.each([4102444800, "4102444800", 4102444800000, "2100-01-01T00:00:00Z"])("normalizes %s to an ISO date", (value) => {
    expect(subscriptionExpiryIso(value)).toBe("2100-01-01T00:00:00.000Z");
  });
  it.each([null, undefined, "", "nonsense", 0, -1, Infinity, 1e30])("does not invent expiry for %s", (value) => {
    expect(subscriptionExpiryIso(value)).toBeNull();
  });
  it("selects the credential's account instead of another workspace", async () => {
    upstream.mockResolvedValueOnce(response({ accounts: {
      other: { account: { id: "other" }, entitlement: { expires_at: 4202444800 } },
      owner: { account: { id: "owner" }, entitlement: { expires_at: 4102444800 } },
    }, account_ordering: ["other", "owner"] }));
    expect(await fetchCodexSubscription(token, "http://proxy:88")).toEqual({
      accountId: "owner", expiresAt: "2100-01-01T00:00:00.000Z",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [proxy, url, options] = upstream.mock.calls[0];
    expect(proxy).toBe("http://proxy:88");
    expect(url).toContain("/accounts/check/");
    expect(options.method).toBe("GET");
    expect(options.headers["ChatGPT-Account-Id"]).toBe("owner");
    expect(options.headers["x-openai-target-path"]).toBe(new URL(url).pathname);
  });
  it("falls back to subscriptions when expiry is missing", async () => {
    upstream.mockResolvedValueOnce(response({ accounts: [{ account: { id: "owner" } }] }))
      .mockResolvedValueOnce(response({ active_until: "4102444800" }));
    expect((await fetchCodexSubscription(token)).expiresAt).toBe("2100-01-01T00:00:00.000Z");
    expect(upstream.mock.calls[1][1]).toBe("https://chatgpt.com/backend-api/subscriptions?account_id=owner");
  });
  it("keeps missing expiry unknown after a successful fallback", async () => {
    upstream.mockResolvedValueOnce(response({ accounts: { owner: { account: { id: "owner" } } } }))
      .mockResolvedValueOnce(response({ subscription_plan: "free" }));
    expect((await fetchCodexSubscription(token)).expiresAt).toBeNull();
  });
  it("fails rather than showing another workspace's expiry", () => {
    expect(() => parseCodexSubscriptionAccount({ accounts: { other: { account: { id: "other" } } } }, "owner"))
      .toThrow("未找到该母号");
  });
  it("reports HTTP failure without echoing credentials or upstream body", async () => {
    upstream.mockResolvedValueOnce(new Response("secret details", { status: 403 }));
    await expect(fetchCodexSubscription(token)).rejects.toThrow("订阅查询失败 (HTTP 403)");
  });
});
