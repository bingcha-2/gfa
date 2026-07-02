import { afterEach, describe, expect, it, vi } from "vitest";

// The reset-credits probes carry the account's codex access token to chatgpt.com,
// so when the account has a sticky exit proxy the request MUST egress through it
// (same IP as inference) instead of leaking the datacenter IP. We mock egress to
// capture the proxyUrl + request shape. Mirrors google-api-egress.spec.ts.
const { egressFetch } = vi.hoisted(() => ({ egressFetch: vi.fn() }));
vi.mock("../../../lease-core/egress", () => ({
  proxyAwareFetch: (proxyUrl: unknown, url: string, init: any) => egressFetch(proxyUrl, url, init),
  proxyRequiredFetch: (proxyUrl: unknown, url: string, init: any) => egressFetch(proxyUrl, url, init),
}));

import {
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  parseResetCreditsSnapshot,
} from "../codex-reset-credits";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("parseResetCreditsSnapshot — mirrors cockpit availability semantics", () => {
  const nowSec = 1_000_000;

  it("counts only credits that are unredeemed and unexpired", () => {
    const snap = parseResetCreditsSnapshot(
      {
        credits: [
          { id: "a", status: "available", expires_at: nowSec + 100 },
          { id: "b", status: "redeemed", expires_at: nowSec + 100 },
          { id: "c", status: "available", expires_at: nowSec - 1 }, // expired
          { id: "d", status: "used", expires_at: nowSec + 100 },
        ],
      },
      nowSec,
    );
    expect(snap.availableCount).toBe(1);
    expect(snap.credits).toHaveLength(4);
  });

  it("prefers the server-provided available_count over the derived count", () => {
    const snap = parseResetCreditsSnapshot(
      { available_count: 5, credits: [{ id: "a", status: "available", expires_at: nowSec + 100 }] },
      nowSec,
    );
    expect(snap.availableCount).toBe(5);
  });

  it("reads credits nested under data and camelCase availableCount", () => {
    const snap = parseResetCreditsSnapshot(
      { data: { availableCount: 2, credits: [{ id: "a", status: "available" }] } },
      nowSec,
    );
    expect(snap.availableCount).toBe(2);
  });

  it("reports the soonest expiry among available credits", () => {
    const snap = parseResetCreditsSnapshot(
      {
        credits: [
          { id: "a", status: "available", expires_at: nowSec + 500 },
          { id: "b", status: "available", expires_at: nowSec + 200 },
          { id: "c", status: "expired", expires_at: nowSec + 50 }, // ignored
        ],
      },
      nowSec,
    );
    expect(snap.nextExpiresAt).toBe(nowSec + 200);
  });

  it("treats a credit with no status as available", () => {
    const snap = parseResetCreditsSnapshot({ credits: [{ id: "a", expires_at: nowSec + 100 }] }, nowSec);
    expect(snap.availableCount).toBe(1);
  });
});

// A JWT whose payload carries the chatgpt_account_id claim (base64url, no sig needed).
function tokenWithAccountId(accId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accId } }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

describe("fetchCodexResetCredits — GET rate-limit-reset-credits through the account proxy", () => {
  afterEach(() => vi.clearAllMocks());

  it("routes through the proxy, sends codex headers, and parses the snapshot", async () => {
    egressFetch.mockResolvedValue(ok({ available_count: 3, credits: [] }));
    const token = tokenWithAccountId("acc-123");
    const snap = await fetchCodexResetCredits(token, "http://proxy:1");

    expect(snap.availableCount).toBe(3);
    const [proxyUrl, url, init] = egressFetch.mock.calls[0];
    expect(proxyUrl).toBe("http://proxy:1");
    expect(url).toContain("/backend-api/wham/rate-limit-reset-credits");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
    expect(init.headers["ChatGPT-Account-Id"]).toBe("acc-123");
    expect(init.headers["OpenAI-Beta"]).toBe("codex-1");
    expect(init.headers.originator).toBe("Codex Desktop");
  });

  it("throws with the upstream status when the request fails", async () => {
    egressFetch.mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(fetchCodexResetCredits("t", undefined)).rejects.toThrow(/403/);
  });
});

describe("consumeCodexResetCredit — POST .../consume through the account proxy", () => {
  afterEach(() => vi.clearAllMocks());

  it("posts a redeem_request_id uuid through the proxy on success", async () => {
    egressFetch.mockResolvedValue(ok({}));
    await consumeCodexResetCredit("t", "http://proxy:1");

    const [proxyUrl, url, init] = egressFetch.mock.calls[0];
    expect(proxyUrl).toBe("http://proxy:1");
    expect(url).toContain("/backend-api/wham/rate-limit-reset-credits/consume");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(typeof body.redeem_request_id).toBe("string");
    expect(body.redeem_request_id.length).toBeGreaterThan(0);
  });

  it("throws with the upstream status when the consume fails", async () => {
    egressFetch.mockResolvedValue(new Response("no credits", { status: 429 }));
    await expect(consumeCodexResetCredit("t", undefined)).rejects.toThrow(/429/);
  });
});
