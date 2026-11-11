import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, pipeline, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

interface GatewayRequest {
  headers: Record<string, string>;
  rawHeaders?: string[];
  body: Buffer;
  signal: AbortSignal;
}

/** Send one request without fetch's synthetic UA/Accept/Sec-Fetch headers,
 * automatic redirects or retries. Keep allowed original header casing and
 * repeated values; authentication and HTTP framing come from the gateway. */
export function requestGatewayUpstream(target: string, init: GatewayRequest): Promise<Response> {
  const url = new URL(target);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported upstream protocol");
  const headers: string[] = [];
  const copied = new Set<string>();
  for (let i = 0; i + 1 < (init.rawHeaders?.length ?? 0); i += 2) {
    const name = init.rawHeaders![i];
    const lower = name.toLowerCase();
    if (lower === "authorization" || !Object.hasOwn(init.headers, lower)) continue;
    headers.push(name, init.rawHeaders![i + 1]);
    copied.add(lower);
  }
  for (const [name, value] of Object.entries(init.headers)) {
    if (!copied.has(name)) headers.push(name, value);
  }
  headers.push("Host", url.host, "Content-Length", String(init.body.length));

  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: "POST", headers, signal: init.signal }, incoming => {
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        const status = incoming.statusCode ?? 502;
        if ([204, 205, 304].includes(status)) {
          incoming.resume();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        // Decode the representation for existing streaming/usage handling.
        // The downstream controller must not reuse compressed framing headers.
        const decoders: Transform[] = [];
        const encodings = (responseHeaders.get("content-encoding") ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        for (const encoding of encodings.reverse()) {
          if (encoding === "gzip" || encoding === "x-gzip") decoders.push(createGunzip());
          else if (encoding === "deflate") decoders.push(createInflate());
          else if (encoding === "br") decoders.push(createBrotliDecompress());
          else if (encoding !== "identity") throw new Error("Unsupported upstream content encoding");
        }
        let body: Readable = incoming;
        if (decoders.length) {
          body = decoders[decoders.length - 1];
          pipeline([incoming, ...decoders], () => { /* errors propagate to the readable body */ });
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end(init.body);
  });
}
