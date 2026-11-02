import "reflect-metadata";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayForwardController } from "./gateway-forward.controller";

class Reply extends EventEmitter {
  code = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  body: any;
  headersSent = false;
  status(code: number) { this.code = code; return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; return this; }
  json(body: any) { this.body = body; this.headersSent = true; return this; }
  send(body: any) { this.body = body; this.headersSent = true; return this; }
  write(chunk: Buffer) { this.chunks.push(chunk); this.headersSent = true; return true; }
  end() { this.headersSent = true; }
}

function fixture() {
  const state = { enabled: true, motherId: "existing-mother", inflight: 0 };
  const users = { resolve: vi.fn().mockResolvedValue(state), hasActiveSubscription: vi.fn().mockResolvedValue(true), quotaStatus: vi.fn().mockResolvedValue({ allowed: true, subscriptionId: "claude-sub", reason: "ok" }), recordUsage: vi.fn().mockResolvedValue(undefined) };
  const pool = { getForwardTarget: vi.fn().mockResolvedValue({ baseUrl: "https://upstream.test", key: "mother-secret", models: ["claude-sonnet-4-6"] }) };
  const controller = new GatewayForwardController(users as any, pool as any);
  const req = { headers: { authorization: "Bearer gfa-desktop-key", "anthropic-version": "2023-06-01", "anthropic-beta": "tools-test" }, body: { model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "hello" }], tools: [{ name: "lookup", input_schema: { type: "object" } }] } };
  return { controller, users, pool, state, req, res: new Reply() };
}

afterEach(() => vi.unstubAllGlobals());
describe("Desktop 3P uses the existing mother gateway and billing", () => {
  it("forwards streamed tool events intact and records all usage once against the same user", async () => {
    const f = fixture();
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 23, output_tokens: 0, cache_read_input_tokens: 9, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 5 } } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } },
      { type: "message_stop" },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
    const data = new TextEncoder().encode(events);
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) {
      // Deliberately split JSON and event boundaries across transport chunks.
      for (let i = 0; i < data.length; i += 13) c.enqueue(data.slice(i, i + 13));
      c.close();
    } }), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    await f.controller.messages(f.req, f.res);
    expect(f.users.resolve).toHaveBeenCalledWith("gfa-desktop-key");
    expect(f.pool.getForwardTarget).toHaveBeenCalledWith("existing-mother");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://upstream.test/v1/messages");
    expect(init.headers.authorization).toBe("Bearer mother-secret");
    expect(init.headers["anthropic-beta"]).toBe("tools-test");
    expect(JSON.parse(init.body)).toEqual(f.req.body);
    expect(Buffer.concat(f.res.chunks).toString()).toBe(events);
    expect(f.users.recordUsage).toHaveBeenCalledExactlyOnceWith(f.state, expect.objectContaining({ model: f.req.body.model, status: 200, tokens: { input: 23, output: 17, cacheRead: 9, cacheWrite5m: 7, cacheWrite1h: 5 } }));
    expect(f.state.inflight).toBe(0);
  });

  it("supports model discovery and token counting without charging", async () => {
    const f = fixture();
    await f.controller.models(f.req, f.res);
    expect(f.res.body.data[0].id).toBe("claude-sonnet-4-6");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"input_tokens":12}')));
    await f.controller.countTokens(f.req, new Reply());
    expect(f.users.recordUsage).not.toHaveBeenCalled();
  });

  it.each(["disabled", "subscription", "quota", "model", "concurrency"])("rejects %s before contacting the mother account", async (reason) => {
    const f = fixture();
    if (reason === "disabled") f.state.enabled = false;
    if (reason === "subscription") f.users.hasActiveSubscription.mockResolvedValue(false);
    if (reason === "quota") f.users.quotaStatus.mockResolvedValue({ allowed: false, subscriptionId: "claude-sub", reason: "quota_7d_exhausted" });
    if (reason === "model") f.req.body.model = "not-allowed";
    if (reason === "concurrency") f.state.inflight = 4;
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await f.controller.messages(f.req, f.res);
    expect(f.res.code).toBeGreaterThanOrEqual(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.users.recordUsage).not.toHaveBeenCalled();
  });

  it("does not advertise or forward an upstream model without a price", async () => {
    const f = fixture();
    f.pool.getForwardTarget.mockResolvedValue({baseUrl:"https://upstream.test",key:"mother-secret",models:["claude-unknown"]});
    await f.controller.models(f.req,f.res);
    expect(f.res.body.data).toEqual([]);
    f.req.body.model="claude-unknown";
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    const reply=new Reply();await f.controller.messages(f.req,reply);
    expect(reply.code).toBe(400);expect(reply.body.error.code).toBe("model_pricing_unavailable");
    expect(fetcher).not.toHaveBeenCalled();expect(f.users.recordUsage).not.toHaveBeenCalled();
  });

  it("does not expose mother credentials on upstream failures", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("mother-secret diagnostic", { status: 401 })));
    await f.controller.messages(f.req, f.res);
    expect(f.res.code).toBe(503);
    expect(JSON.stringify(f.res.body)).not.toContain("mother-secret");
    expect(f.state.inflight).toBe(0);
  });

  it("explains upstream calibration and preserves retry timing without exposing provider secrets", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: "calibration_pending", message: "mother-secret diagnostic", boundAccount: "private@example.test",
    } }), { status: 429, headers: { "retry-after": "300" } })));
    await f.controller.messages(f.req, f.res);
    expect(f.res.code).toBe(429);
    expect(f.res.headers["retry-after"]).toBe("300");
    expect(f.res.body.error.code).toBe("upstream_calibration_pending");
    expect(JSON.stringify(f.res.body)).not.toContain("mother-secret");
    expect(JSON.stringify(f.res.body)).not.toContain("private@example.test");
    expect(f.users.recordUsage).not.toHaveBeenCalled();
    expect(f.state.inflight).toBe(0);
  });
});
