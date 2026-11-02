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

import { Public } from "../../shared/auth/public.decorator";
import { GatewayPoolService } from "./gateway-pool.service";
import { GatewayUserService, type UsageTokens, type UserState } from "./gateway-user.service";

const MAX_INFLIGHT_PER_USER = 4;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
// 只透传这几个请求头,其余(尤其是 authorization)一律换成母号 key。
const PASS_HEADERS = ["anthropic-version", "anthropic-beta", "content-type", "accept"];

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
    const headers: Record<string, string> = { authorization: `Bearer ${target.key}`, "x-request-id": requestId };
    for (const h of PASS_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    headers["content-type"] = "application/json";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    res.on("close", () => ctrl.abort()); // 客户端断开 → 终止上游,省额度
    s.inflight++;
    let tokens: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    let status = 502;
    try {
      const up = await fetch(`${target.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      status = up.status;
      if (!up.ok) {
        // 上游错误不透出,统一改写。
        const code = up.status === 429 ? 429 : up.status === 401 || up.status === 403 ? 503 : up.status >= 500 ? 502 : 400;
        let msg = up.status === 429 ? "服务繁忙,请稍后再试" : up.status === 400 ? "请求无效" : "服务暂不可用,请稍后再试";
        const upstreamError = await up.json().catch(() => null) as any;
        // Keep credentials/account diagnostics private, but do not conceal a
        // known provider admission failure behind a misleading generic message.
        if (up.status === 429) {
          const retryAfter = up.headers.get("retry-after");
          if (retryAfter && /^\d{1,5}$/.test(retryAfter)) res.setHeader("retry-after", retryAfter);
          if (upstreamError?.error?.code === "calibration_pending") {
            msg = "上游账号额度尚未完成校准，暂时无法调用；请联系服务方处理";
            return void res.status(429).json({
              type: "error",
              error: { type: "rate_limit_error", code: "upstream_calibration_pending", message: msg },
            });
          }
        }
        return void res.status(code).json(errorBody(code === 429 ? "rate_limit_error" : "api_error", msg));
      }

      const ct = up.headers.get("content-type") || "application/json";
      res.status(up.status).setHeader("content-type", ct);
      res.setHeader("x-gfa-request-id", requestId);
      if (!billed || !up.body) {
        res.send(Buffer.from(await up.arrayBuffer()));
        return;
      }

      if (ct.includes("text/event-stream")) {
        res.setHeader("cache-control", "no-cache");
        let buf = "";
        const readable = Readable.fromWeb(up.body as any);
        await new Promise<void>((resolve) => {
          readable.on("data", (chunk: Buffer) => {
            res.write(chunk); // 原样透传,不缓冲
            buf += chunk.toString("utf8");
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
              try {
                const ev = JSON.parse(line.slice(5));
                if (ev?.type === "message_start") tokens = toTokens(ev.message?.usage, tokens);
                else if (ev?.type === "message_delta") tokens = toTokens(ev.usage, tokens);
              } catch {
                /* 忽略不完整的行 */
              }
            }
          });
          readable.on("end", () => {
            res.end();
            resolve();
          });
          readable.on("error", () => {
            res.end();
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
      else res.end();
    } finally {
      clearTimeout(timer);
      s.inflight--;
      if (billed && (tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite5m || tokens.cacheWrite1h)) {
        await this.users.recordUsage(s, { requestId, model, tokens, status, occurredAt, pricingMode, subscriptionId }).catch(error => Logger.error(`Usage persistence failed for ${requestId}: ${error?.message}`, "GatewayBilling"));
      }
    }
  }
}
