import "reflect-metadata";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayForwardController } from "./gateway-forward.controller";
import { configureGatewayJsonParser } from "./gateway-body-parser";
import * as gatewayTransport from "./gateway-upstream";

class Reply extends EventEmitter {
  code = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  body: any;
  headersSent = false;
  destroyed = false;
  ended = false;
  status(code: number) { this.code = code; return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; return this; }
  json(body: any) { this.body = body; this.headersSent = true; return this; }
  send(body: any) { this.body = body; this.headersSent = true; return this; }
  write(chunk: Buffer) { this.chunks.push(chunk); this.headersSent = true; return true; }
  end() { this.headersSent = true; this.ended = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

function fixture() {
  const state = { enabled: true, motherId: "existing-mother", inflight: 0 };
  const users = { resolve: vi.fn().mockResolvedValue(state), hasActiveSubscription: vi.fn().mockResolvedValue(true), quotaStatus: vi.fn().mockResolvedValue({ allowed: true, subscriptionId: "claude-sub", reason: "ok" }), recordUsage: vi.fn().mockResolvedValue(undefined) };
  const pool = { getForwardTarget: vi.fn().mockResolvedValue({ baseUrl: "https://upstream.test", key: "mother-secret", models: ["claude-sonnet-4-6"] }) };
  const controller = new GatewayForwardController(users as any, pool as any);
  const req = { rawBody: Buffer.alloc(0), headers: { authorization: "Bearer gfa-desktop-key", "anthropic-version": "2023-06-01", "anthropic-beta": "tools-test" }, body: { model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "hello" }], tools: [{ name: "lookup", input_schema: { type: "object" } }] } };
  req.rawBody = Buffer.from(JSON.stringify(req.body));
  return { controller, users, pool, state, req, res: new Reply() };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("Desktop 3P uses the existing mother gateway and billing", () => {
  it.each(["messages", "countTokens"] as const)("preserves CLI protocol fields and query encoding for %s", async (method) => {
    const f = fixture();
    const path = method === "messages" ? "/v1/messages" : "/v1/messages/count_tokens";
    const query = "?beta=true&tag=a%2Fb&tag=c+d&empty=";
    const cliHeaders = {
      "user-agent": "claude-cli/test-version (external, cli)",
      "x-app": "cli", "accept-encoding": "gzip", accept: "application/json",
      "content-type": "application/json; charset=utf-8",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-stainless-arch": "x64", "x-stainless-os": "Windows",
      "x-stainless-lang": "js", "x-stainless-runtime": "node",
      "x-stainless-package-version": "test-sdk", "x-stainless-runtime-version": "test-runtime",
      "x-stainless-retry-count": "1", "x-stainless-timeout": "600",
      "x-client-request-id": "client-request", "x-request-id": "original-request",
      "x-claude-code-session-id": "client-session", "future-cli-header": "keep-me",
      "sec-fetch-mode": "same-origin", "sec-fetch-site": "same-origin",
      origin: "https://sender.test", referer: "https://sender.test/session",
    };
    Object.assign(f.req, { originalUrl: `/api/gateway${path}${query}` });
    Object.assign(f.req.headers, cliHeaders);
    Object.assign(f.req.body, { metadata: { user_id: "original-client-identity" }, system: "original system" });
    f.req.rawBody = Buffer.from(JSON.stringify(f.req.body));
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"input_tokens":12}'));
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(fetchMock);
    await f.controller[method](f.req, f.res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://upstream.test${path}${query}`);
    expect(init.headers).toMatchObject(cliHeaders);
    expect(init.headers.authorization).toBe("Bearer mother-secret");
    expect(JSON.parse(init.body)).toEqual(f.req.body);
  });

  it("replaces gateway credentials and removes proxy/framing fields, including Connection-nominated headers", async () => {
    const f = fixture();
    const localHeaders = {
      "x-api-key": "gfa-api-key", "x-goog-api-key": "other-private-key", cookie: "session=private", "proxy-authorization": "Basic private",
      host: "gfa.test", "content-length": "999999", "content-encoding": "gzip",
      connection: "keep-alive, X-Local-Only", "keep-alive": "timeout=5", "x-local-only": "private",
      "transfer-encoding": "chunked", te: "trailers", trailer: "private", upgrade: "websocket", expect: "100-continue",
      forwarded: "for=192.0.2.1", "x-forwarded-for": "192.0.2.1", "x-forwarded-host": "gfa.test",
      "x-forwarded-proto": "https", "x-real-ip": "192.0.2.1", "x-gfa-device-id": "private",
      "x-bcai-user": "private",
    };
    Object.assign(f.req.headers, localHeaders);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"input_tokens":12}'));
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(fetchMock);
    await f.controller.countTokens(f.req, f.res);
    expect(f.users.resolve).toHaveBeenCalledWith("gfa-api-key");
    const [, init] = fetchMock.mock.calls[0];
    for (const name of Object.keys(localHeaders)) expect(init.headers).not.toHaveProperty(name);
    expect(init.headers.authorization).toBe("Bearer mother-secret");
    expect(init.headers).not.toHaveProperty("x-request-id");
    expect(JSON.stringify(init)).not.toContain("gfa-api-key");
    expect(JSON.stringify(init)).not.toContain("gfa-desktop-key");
  });

  it("preserves CLI headers on the actual local HTTP wire and handles a compressed response", async () => {
    const f = fixture();
    let captured: { url?: string; headers: any; rawHeaders: string[]; body: string } | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captured = { url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString() };
      const response = gzipSync('{"input_tokens":12}');
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": response.length });
      res.end(response);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nativeTransport = gatewayTransport.requestGatewayUpstream;
    // Fail closed: this test may contact only its own loopback server.
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation((url, init) => {
      if (!String(url).startsWith(`${baseUrl}/`)) throw new Error("External request forbidden");
      return nativeTransport(url, init);
    });
    try {
      f.pool.getForwardTarget.mockResolvedValue({ baseUrl, key: "mother-secret", models: ["claude-sonnet-4-6"] });
      Object.assign(f.req, { originalUrl: "/api/gateway/v1/messages/count_tokens?beta=true" });
      Object.assign(f.req.headers, { "user-agent": "claude-cli/local-test (external, cli)", "x-app": "cli", "x-stainless-retry-count": "0", "accept-encoding": "gzip", "content-length": "1", "sec-fetch-mode": "same-origin", "x-future-option": "first, second" });
      Object.assign(f.req, { rawHeaders: ["User-Agent", "claude-cli/local-test (external, cli)", "X-Future-Option", "first", "X-Future-Option", "second", "Authorization", "Bearer gfa-desktop-key"] });
      await f.controller.countTokens(f.req, f.res);
      expect(f.res.code).toBe(200);
      expect(captured?.url).toBe("/v1/messages/count_tokens?beta=true");
      expect(captured?.headers).toMatchObject({ "user-agent": "claude-cli/local-test (external, cli)", "x-app": "cli", "x-stainless-retry-count": "0", "accept-encoding": "gzip", authorization: "Bearer mother-secret" });
      expect(captured?.headers["sec-fetch-mode"]).toBe("same-origin");
      expect(captured?.headers).not.toHaveProperty("accept-language");
      expect(captured?.headers).not.toHaveProperty("accept");
      expect(captured?.rawHeaders.slice(0, 6)).toEqual(["User-Agent", "claude-cli/local-test (external, cli)", "X-Future-Option", "first", "X-Future-Option", "second"]);
      expect(captured?.rawHeaders).not.toContain("Bearer gfa-desktop-key");
      expect(Number(captured?.headers["content-length"])).toBe(Buffer.byteLength(captured!.body));
      expect(JSON.parse(captured!.body)).toEqual(f.req.body);
      expect(f.res.body.toString()).toBe('{"input_tokens":12}');
      expect(f.res.headers).not.toHaveProperty("content-encoding");
      expect(f.res.headers).not.toHaveProperty("x-gfa-request-id");
      expect(f.users.recordUsage).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([false, true])("keeps JSON bytes intact through the real Nest parser (compressed request: %s)", async (compressed) => {
    const f = fixture();
    const original = Buffer.from('{\n  "model":"claude-sonnet-4-6", "number":900719925474099312345, "escaped":"\\u4e2d\\u6587", "text":"中文😀", "unknown":{"x":1}\n}\n');
    let received: Buffer | undefined;
    let receivedHeaders: any;
    let receivedPath: string | undefined;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      receivedHeaders = req.headers;
      receivedPath = req.url;
      res.setHeader("content-type", "application/json");
      res.end('{"input_tokens":12}');
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const app = await NestFactory.create<NestExpressApplication>({ module: class WireTestModule {} }, { logger: false, rawBody: true });
    const nativeFetch = globalThis.fetch;
    try {
      app.useBodyParser("urlencoded", { extended: true });
      configureGatewayJsonParser(app);
      app.getHttpAdapter().post("/api/gateway/v1/messages/count_tokens", (req: any, res: any) => f.controller.countTokens(req, res));
      app.getHttpAdapter().post("/other-json-route", (req: any, res: any) => res.json({ retained: Buffer.isBuffer(req.rawBody), parsed: req.body }));
      await app.listen(0, "127.0.0.1");
      const apiUrl = await app.getUrl();
      vi.stubGlobal("fetch", vi.fn((url, init) => {
        if (![baseUrl, apiUrl].some(base => String(url).startsWith(`${base}/`))) throw new Error("External request forbidden");
        return nativeFetch(url, init);
      }));
      f.pool.getForwardTarget.mockResolvedValue({ baseUrl, key: "mother-secret", models: ["claude-sonnet-4-6"] });
      const response = await fetch(`${apiUrl}/api/gateway/v1/messages/count_tokens?beta=true&tag=%2F&tag=a+b`, {
        method: "POST",
        headers: { authorization: "Bearer gfa-fixture", "content-type": "application/json", "user-agent": "cli-wire-test", ...(compressed ? { "content-encoding": "gzip" } : {}) },
        body: compressed ? gzipSync(original) : original,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ input_tokens: 12 });
      expect(received?.equals(original)).toBe(true);
      expect(receivedPath).toBe("/v1/messages/count_tokens?beta=true&tag=%2F&tag=a+b");
      expect(receivedHeaders["content-encoding"]).toBeUndefined();
      expect(receivedHeaders["user-agent"]).toBe("cli-wire-test");
      expect(Number(receivedHeaders["content-length"])).toBe(original.length);
      const other = await fetch(`${apiUrl}/other-json-route`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"hello":1}' });
      expect(await other.json()).toEqual({ retained: false, parsed: { hello: 1 } });
      const form = await fetch(`${apiUrl}/other-json-route`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "hello=1" });
      expect(await form.json()).toEqual({ retained: false, parsed: { hello: "1" } });
    } finally {
      await app.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects a missing raw JSON body instead of silently reserializing it", async () => {
    const f = fixture();
    const fetchMock = vi.fn();
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(fetchMock);
    await f.controller.countTokens({ ...f.req, rawBody: undefined }, f.res);
    expect(f.res.code).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 408, 429, 500, 503, 529])("preserves upstream status %s and retry hints while redacting private error details", async (status) => {
    const f = fixture();
    const retryAfter = "Wed, 11 Nov 2026 13:00:00 GMT";
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(vi.fn().mockResolvedValue(new Response('{"error":{"message":"mother-secret private@example.test"}}', {
      status, headers: { "retry-after": retryAfter, "retry-after-ms": "500", "x-should-retry": "false", "request-id": "upstream-request", "set-cookie": "secret=private" },
    })));
    await f.controller.messages(f.req, f.res);
    expect(f.res.code).toBe(status);
    expect(f.res.headers).toMatchObject({ "retry-after": retryAfter, "retry-after-ms": "500", "x-should-retry": "false", "request-id": "upstream-request" });
    expect(f.res.headers).not.toHaveProperty("set-cookie");
    expect(JSON.stringify(f.res.body)).not.toMatch(/mother-secret|private@example/);
    if (status === 401) expect(f.res.body.error.type).toBe("authentication_error");
    if (status === 403) expect(f.res.body.error.type).toBe("permission_error");
  });

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
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(fetchMock);
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
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(vi.fn().mockResolvedValue(new Response('{"input_tokens":12}')));
    await f.controller.countTokens(f.req, new Reply());
    expect(f.users.recordUsage).not.toHaveBeenCalled();
  });

  it("preserves streamed bytes under backpressure", async () => {
    const f = fixture();
    const expected = Buffer.from('data: {"type":"content_block_delta","delta":{"text":"中文😀"}}\n\ndata: {"type":"message_stop"}\n\n');
    let offset = 0;
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(c) {
        if (offset === expected.length) return c.close();
        c.enqueue(expected.subarray(offset, ++offset));
      },
    }), { headers: { "content-type": "text/event-stream" } })));
    const write = f.res.write.bind(f.res);
    vi.spyOn(f.res, "write").mockImplementation(chunk => {
      write(chunk);
      setImmediate(() => f.res.emit("drain"));
      return false;
    });
    await f.controller.messages(f.req, f.res);
    expect(Buffer.concat(f.res.chunks).equals(expected)).toBe(true);
    expect(f.res.ended).toBe(true);
    expect(f.res.destroyed).toBe(false);
    expect(f.res.listenerCount("drain")).toBe(0);
    expect(f.state.inflight).toBe(0);
  });

  it("signals an interrupted upstream stream instead of reporting normal completion", async () => {
    const f = fixture();
    let sent = false;
    const partial = Buffer.from('data: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n');
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(partial); }
        else c.error(new Error("mother-secret transport failure"));
      },
    }), { headers: { "content-type": "text/event-stream" } })));
    await f.controller.messages(f.req, f.res);
    expect(f.res.destroyed).toBe(true);
    expect(f.res.ended).toBe(false);
    expect(Buffer.concat(f.res.chunks).toString()).not.toContain("mother-secret");
    expect(f.state.inflight).toBe(0);
  });

  it("detects a clean EOF without a terminal event and retains partial usage", async () => {
    const f = fixture();
    const bytes = 'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n';
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockResolvedValue(new Response(bytes, { headers: { "content-type": "text/event-stream" } }));
    await f.controller.messages(f.req, f.res);
    expect(Buffer.concat(f.res.chunks).toString()).toBe(bytes);
    expect(f.res.destroyed).toBe(true);
    expect(f.res.ended).toBe(false);
    expect(f.users.recordUsage).toHaveBeenCalledExactlyOnceWith(f.state, expect.objectContaining({ tokens: expect.objectContaining({ input: 12 }) }));
  });

  it.each(["disabled", "subscription", "quota", "model", "concurrency"])("rejects %s before contacting the mother account", async (reason) => {
    const f = fixture();
    if (reason === "disabled") f.state.enabled = false;
    if (reason === "subscription") f.users.hasActiveSubscription.mockResolvedValue(false);
    if (reason === "quota") f.users.quotaStatus.mockResolvedValue({ allowed: false, subscriptionId: "claude-sub", reason: "quota_7d_exhausted" });
    if (reason === "model") f.req.body.model = "not-allowed";
    if (reason === "concurrency") f.state.inflight = 4;
    const fetchMock = vi.fn(); vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(fetchMock);
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
    const fetcher=vi.fn();vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(fetcher);
    const reply=new Reply();await f.controller.messages(f.req,reply);
    expect(reply.code).toBe(400);expect(reply.body.error.code).toBe("model_pricing_unavailable");
    expect(fetcher).not.toHaveBeenCalled();expect(f.users.recordUsage).not.toHaveBeenCalled();
  });

  it("does not expose mother credentials on upstream failures", async () => {
    const f = fixture();
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(vi.fn().mockResolvedValue(new Response("mother-secret diagnostic", { status: 401 })));
    await f.controller.messages(f.req, f.res);
    expect(f.res.code).toBe(401);
    expect(JSON.stringify(f.res.body)).not.toContain("mother-secret");
    expect(f.state.inflight).toBe(0);
  });

  it("explains upstream calibration and preserves retry timing without exposing provider secrets", async () => {
    const f = fixture();
    vi.spyOn(gatewayTransport, "requestGatewayUpstream").mockImplementation(vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
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
