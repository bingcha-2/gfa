import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { requestGatewayUpstream } from "./gateway-upstream";

async function withUpstream(listener: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const options = () => ({ headers: { authorization: "Bearer local-fixture" }, body: Buffer.from("{}"), signal: new AbortController().signal });

describe("gateway HTTP transport", () => {
  it("does not invent SDK headers or follow a redirect with credentials", async () => {
    let calls = 0;
    let received: any;
    await withUpstream((req, res) => {
      calls++;
      received = req.headers;
      res.writeHead(307, { location: "/must-not-follow" });
      res.end("redirect-body");
    }, async url => {
      const response = await requestGatewayUpstream(`${url}/v1/messages?beta=true`, options());
      expect(response.status).toBe(307);
      expect(await response.text()).toBe("redirect-body");
      expect(calls).toBe(1);
      for (const name of ["user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-mode", "x-request-id"]) {
        expect(received).not.toHaveProperty(name);
      }
      expect(received.authorization).toBe("Bearer local-fixture");
    });
  });

  it("propagates cancellation after response headers instead of hanging on its body", async () => {
    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
    }, async url => {
      const controller = new AbortController();
      const response = await requestGatewayUpstream(url, { ...options(), signal: controller.signal });
      const reading = response.text();
      controller.abort();
      await expect(reading).rejects.toThrow();
    });
  });

  it("reports a corrupt compressed body as a failure", async () => {
    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end("not-gzip");
    }, async url => {
      const response = await requestGatewayUpstream(url, options());
      await expect(response.arrayBuffer()).rejects.toThrow();
    });
  });
});
