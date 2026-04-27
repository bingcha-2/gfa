import { All, Controller, Req, Res } from "@nestjs/common";

import { Public } from "./auth/public.decorator";

const REMOTE_TOKEN_BASE_URL =
  process.env.REMOTE_TOKEN_SERVER_URL || "http://127.0.0.1:60700";

const ALLOWED_PATHS = new Set([
  "status",
  "health",
  "lease-token",
  "report-result",
  "reload-accounts",
]);

@Public()
@Controller("remote-token")
export class RemoteTokenController {
  @All(":targetPath")
  async forward(@Req() request: any, @Res() response: any) {
    const targetPath = String(request.params?.targetPath || "").trim();
    if (!ALLOWED_PATHS.has(targetPath)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    const upstream = new URL(targetPath, `${REMOTE_TOKEN_BASE_URL.replace(/\/+$/, "")}/`);
    for (const [key, value] of Object.entries(request.query || {})) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.searchParams.append(key, String(item));
      } else if (value !== undefined) {
        upstream.searchParams.append(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: "application/json",
    };
    for (const name of ["authorization", "x-token-server-secret", "content-type"]) {
      const value = request.headers?.[name];
      if (typeof value === "string" && value) headers[name] = value;
    }

    const init: RequestInit = {
      method: request.method,
      headers,
      cache: "no-store",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = JSON.stringify(request.body || {});
      headers["content-type"] = headers["content-type"] || "application/json";
    }

    try {
      const upstreamResponse = await fetch(upstream, init);
      const text = await upstreamResponse.text();
      const contentType = upstreamResponse.headers.get("content-type");
      if (contentType) response.setHeader("content-type", contentType);
      response.status(upstreamResponse.status).send(text);
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : "Remote Token Server unavailable",
      });
    }
  }
}
