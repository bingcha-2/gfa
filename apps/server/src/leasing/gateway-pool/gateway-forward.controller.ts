/**
 * gateway-forward.controller.ts — 面向用户客户端的转发入口(Anthropic 兼容)。
 *
 *   POST /api/gateway/v1/messages               转发推理(含流式)
 *   POST /api/gateway/v1/messages/count_tokens  透传,不计费
 *   GET  /api/gateway/v1/models                 返回该用户母号的缓存模型列表,不打上游
 *
 * 客户端把 ANTHROPIC_BASE_URL 指到 {gfa}/api/gateway,用 gfa 发的专用 key 鉴权。
 * 母号 key 只在这里解密、用完即丢;上游的错误一律改写成 gfa 自己的文案,不透出母号信息。
 * 网关额度使用内存缓存；客户状态和订阅资格每次请求查库，防止停用/到期后继续调用。
 */
import { hasApiPrice } from "@gfa/shared";
import { refreshModelPricing } from "../../shared/pricing/pricing.module";
import { Controller, Get, Post, Req, Res, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { Public } from "../../shared/auth/public.decorator";
import { GatewayPoolService } from "./gateway-pool.service";
import { GatewayUserService, type UsageTokens, type UserState } from "./gateway-user.service";
import { requestGatewayUpstream } from "./gateway-upstream";

const MAX_INFLIGHT_PER_USER = 4;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
// Preserve end-to-end CLI headers, including new SDK/beta headers. Credentials
// belong to this gateway; framing and proxy-routing headers belong to this hop.
const LOCAL_HEADERS = new Set([
  "authorization", "x-api-key", "x-goog-api-key", "cookie", "cookie2",
  "host", "content-length", "content-encoding",
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "expect",
  "forwarded", "x-real-ip",
]);

function upstreamHeaders(incoming: Record<string, string | string[] | undefined>, key: string) {
  const connection = incoming.connection;
  const hopHeaders = new Set((Array.isArray(connection) ? connection.join(",") : connection ?? "")
    .split(",").map(name => name.trim().toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (LOCAL_HEADERS.has(lower) || hopHeaders.has(lower) || lower.startsWith(":") ||
      /^(x-forwarded-|x-gfa-|x-bcai-)/.test(lower) || value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.authorization = `Bearer ${key}`;
  headers["content-type"] ??= "application/json";
  return headers;
}

function originalQuery(req: any): string {
  const url = req.originalUrl ?? req.url ?? "";
  const queryStart = url.indexOf("?");
  // Preserve encoding, repeated values and ordering; never use the incoming
  // host/path to choose the upstream destination.
  return queryStart < 0 ? "" : url.slice(queryStart);
}

function errorBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

function bearerOrApiKey(req: any): string {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x) return x.trim();
  const a = req.headers.authorization;
  const m = typeof a === "string" ? /^Bearer\s+(.+)$/i.exec(a.trim()) : null;
  return m ? m[1].trim() : "";
}

const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/** 把 Anthropic usage 对象折算成计费用的 5 类 token。 */
function toTokens(u: any, prev?: UsageTokens): UsageTokens {
  const w5 = n(u?.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = n(u?.cache_creation?.ephemeral_1h_input_tokens);
  const wTotal = n(u?.cache_creation_input_tokens);
  return {
    input: u?.input_tokens !== undefined ? n(u.input_tokens) : prev?.input ?? 0,
    output: u?.output_tokens !== undefined ? n(u.output_tokens) : prev?.output ?? 0,
    cacheRead: u?.cache_read_input_tokens !== undefined ? n(u.cache_read_input_tokens) : prev?.cacheRead ?? 0,
    // 没有 5m/1h 拆分时,整体按 5 分钟价计。
    cacheWrite5m: u?.cache_creation !== undefined || u?.cache_creation_input_tokens !== undefined ? (w5 || (w1 ? 0 : wTotal)) : prev?.cacheWrite5m ?? 0,
    cacheWrite1h: u?.cache_creation !== undefined ? w1 : prev?.cacheWrite1h ?? 0,
  };
}

@Public()
@Controller("gateway/v1")
export class GatewayForwardController {
  constructor(
    private readonly users: GatewayUserService,
    private readonly pool: GatewayPoolService,
  ) {}

  private async auth(req: any, res: any): Promise<UserState | null> {
    const s = await this.users.resolve(bearerOrApiKey(req));
    if (!s || !s.enabled) {
      res.status(401).json(errorBody("authentication_error", "密钥无效或已停用"));
      return null;
    }
    if (!(await this.users.hasActiveSubscription(s.customerId))) {
      res.status(403).json(errorBody("permission_error", "需要有效的 Claude 订阅，请续费或购买套餐"));
      return null;
    }
    return s;
  }

  @Get("models")
  async models(@Req() req: any, @Res() res: any) {
    const s = await this.auth(req, res);
    if (!s) return;
    const target = await this.pool.getForwardTarget(s.motherId);
    const ids = (target?.models ?? []).filter(id => hasApiPrice("anthropic", id));
    res.json({
      data: ids.map((id) => ({ type: "model", id, display_name: id })),
      has_more: false,
      first_id: ids[0] ?? null,
      last_id: ids[ids.length - 1] ?? null,
    });
  }

  @Post("messages/count_tokens")
  async countTokens(@Req() req: any, @Res() res: any) {
    const s = await this.auth(req, res);
    if (!s) return;
    await this.forward(req, res, s, "/v1/messages/count_tokens", false);
  }

  @Post("messages")
  async messages(@Req() req: any, @Res() res: any) {
    const s = await this.auth(req, res);
    if (!s) return;
    await this.forward(req, res, s, "/v1/messages", true);
  }

  private async forward(req: any, res: any, s: UserState, path: string, billed: boolean) {
    // Parse for access/billing checks, but send the original bytes. Serializing
    // req.body would alter escaping, whitespace and large numeric literals.
    if (!Buffer.isBuffer(req.rawBody)) {
      return void res.status(400).json(errorBody("invalid_request_error", "需要 JSON 请求正文"));
    }
    const body: any = req.body;
    const model = String(body?.model || "");
    const pricingMode = body?.speed === "fast" || body?.service_tier === "priority" ? "priority" : "standard";
    let occurredAt = Date.now();
    let subscriptionId: string | null = null;
    if (billed) {
      if (!model) return void res.status(400).json(errorBody("invalid_request_error", "缺少 model"));
      if (!hasApiPrice("anthropic", model, pricingMode, Date.now(), Number.MAX_SAFE_INTEGER)) await refreshModelPricing();
      occurredAt = Date.now();
      if (!hasApiPrice("anthropic", model, pricingMode, occurredAt, Number.MAX_SAFE_INTEGER)) {
        return void res.status(400).json({ type: "error", error: { type: "invalid_request_error", code: "model_pricing_unavailable", message: "该模型当前暂未开放，请选择其他模型" } });
      }
      const quota = await this.users.quotaStatus(s);
      if (!quota.allowed) {
        const exhausted = quota.reason.startsWith("quota_") && quota.reason.endsWith("_exhausted");
        const status = quota.reason === "subscription_required" ? 403 : exhausted || quota.reason === "quota_reading_uncertain" ? 429 : 503;
        const message = quota.reason === "subscription_required" ? "需要有效的 Claude 订阅，请续费或购买套餐" :
          quota.reason === "quota_5h_exhausted" ? "5 小时额度已用完，请等待恢复" :
          quota.reason === "quota_7d_exhausted" ? "本周额度已用完，请等待恢复" : "额度信息暂未确认，请稍后重试";
        if (quota.retryAt && quota.retryAt > Date.now()) res.setHeader("retry-after", String(Math.ceil((quota.retryAt - Date.now()) / 1000)));
        return void res.status(status).json(errorBody(status === 429 ? "rate_limit_error" : "permission_error", message));
      }
      subscriptionId = quota.subscriptionId;

    }
    if (s.inflight >= MAX_INFLIGHT_PER_USER) {
      return void res.status(429).json(errorBody("rate_limit_error", "并发请求过多,请稍后再试"));
    }
    const target = await this.pool.getForwardTarget(s.motherId);
    if (!target) return void res.status(503).json(errorBody("api_error", "服务暂不可用,请稍后再试"));
    if (billed && target.models.length > 0 && !target.models.includes(model)) {
      return void res.status(400).json(errorBody("invalid_request_error", `不支持的模型:${model}`));
    }

    // A quota/target await can allow another request to occupy the last slot.
    if (s.inflight >= MAX_INFLIGHT_PER_USER) return void res.status(429).json(errorBody("rate_limit_error", "并发请求过多,请稍后再试"));
    const requestId = randomUUID();
    const headers = upstreamHeaders(req.headers, target.key);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    res.on("close", () => ctrl.abort()); // 客户端断开 → 终止上游,省额度
    s.inflight++;
    let tokens: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    let status = 502;
    try {
      const up = await requestGatewayUpstream(`${target.baseUrl}${path}${originalQuery(req)}`, {
        headers,
        rawHeaders: req.rawHeaders,
        body: req.rawBody,
        signal: ctrl.signal,
      });
      status = up.status;
      // Preserve retry/diagnostic semantics without exposing credentials or
      // copying framing headers (the transport may have decompressed the body).
      for (const name of ["request-id", "x-request-id", "retry-after", "retry-after-ms", "x-should-retry"]) {
        const value = up.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      if (!up.ok) {
        // Keep private diagnostics out of the body, but do not turn permanent
        // authentication failures into retryable 503 responses.
        const code = up.status;
        let msg = up.status === 429 ? "服务繁忙,请稍后再试" : up.status === 400 ? "请求无效" : "服务暂不可用,请稍后再试";
        const upstreamError = await up.json().catch(() => null) as any;
        // Keep credentials/account diagnostics private, but do not conceal a
        // known provider admission failure behind a misleading generic message.
        if (up.status === 429) {
          if (upstreamError?.error?.code === "calibration_pending") {
            msg = "上游账号额度尚未完成校准，暂时无法调用；请联系服务方处理";
            return void res.status(429).json({
              type: "error",
              error: { type: "rate_limit_error", code: "upstream_calibration_pending", message: msg },
            });
          }
        }
        const type = code === 401 ? "authentication_error" : code === 403 ? "permission_error" :
          code === 429 ? "rate_limit_error" : code === 400 ? "invalid_request_error" : "api_error";
        return void res.status(code).json(errorBody(type, msg));
      }

      const ct = up.headers.get("content-type") || "application/json";
      res.status(up.status).setHeader("content-type", ct);
      if (!billed || !up.body) {
        res.send(Buffer.from(await up.arrayBuffer()));
        return;
      }

      if (ct.includes("text/event-stream")) {
        res.setHeader("cache-control", "no-cache");
        let buf = "";
        let terminal = false;
        const decoder = new StringDecoder("utf8");
        const observeLine = (line: string) => {
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { terminal = true; return; }
          try {
            const ev = JSON.parse(data);
            if (ev?.type === "message_stop" || ev?.type === "error") terminal = true;
            if (ev?.type === "message_start") tokens = toTokens(ev.message?.usage, tokens);
            else if (ev?.type === "message_delta") tokens = toTokens(ev.usage, tokens);
          } catch { /* Observe only; never rewrite the original stream. */ }
        };
        const readable = Readable.fromWeb(up.body as any);
        await new Promise<void>((resolve) => {
          const resume = () => readable.resume();
          const cleanup = () => res.off("drain", resume);
          readable.on("data", (chunk: Buffer) => {
            if (!res.write(chunk)) {
              readable.pause();
              res.once("drain", resume);
            }
            buf += decoder.write(chunk);
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              observeLine(line);
            }
          });
          readable.on("end", () => {
            cleanup();
            observeLine((buf + decoder.end()).trim());
            if (terminal) res.end();
            else res.destroy(); // A clean TCP EOF is not necessarily a complete Claude response.
            resolve();
          });
          readable.on("error", () => {
            cleanup();
            // Ending normally would make a truncated stream look complete.
            // Destroy without forwarding upstream error details to the client.
            res.destroy();
            resolve();
          });
        });
      } else {
        const buf = Buffer.from(await up.arrayBuffer());
        res.send(buf);
        try {
          tokens = toTokens(JSON.parse(buf.toString("utf8"))?.usage);
        } catch {
          /* 非 JSON,不计费 */
        }
      }
    } catch {
      if (!res.headersSent) res.status(ctrl.signal.aborted ? 499 : 502).json(errorBody("api_error", "服务暂不可用,请稍后再试"));
      else res.destroy();
    } finally {
      clearTimeout(timer);
      s.inflight--;
      if (billed && (tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite5m || tokens.cacheWrite1h)) {
        await this.users.recordUsage(s, { requestId, model, tokens, status, occurredAt, pricingMode, subscriptionId }).catch(error => Logger.error(`Usage persistence failed for ${requestId}: ${error?.message}`, "GatewayBilling"));
      }
    }
  }
}
